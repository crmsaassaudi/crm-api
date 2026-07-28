import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ModuleRef } from '@nestjs/core';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CustomRoleSchemaClass,
  CustomRoleDocument,
} from './custom-role.schema';
import {
  CloneCustomRoleDto,
  CreateCustomRoleDto,
  UpdateCustomRoleDto,
} from './custom-roles.dto';
import {
  PERMISSION_REGISTRY,
  ALL_PERMISSIONS,
  CORE_PERMISSIONS,
} from './permission.constants';
import { getTenantPermissions, PermissionTenant } from './permission.engine';
import { DataScope, scopeAtLeast } from './data-scope.enum';
import { ADMINISTRATOR_PSEUDO_ROLE } from './system-role-templates';
import { CustomRole } from './domain/custom-role';
import { CustomRoleMapper } from './mappers/custom-role.mapper';
import { AuthzAuditService } from '../authz-audit/authz-audit.service';
import { TenantsRepository } from '../../tenants/infrastructure/persistence/document/repositories/tenant.repository';
import type { AuthzPermissionCacheService } from './authz-permission-cache.service';
import { AUTHZ_PERMISSION_CACHE } from './authz.tokens';

@Injectable()
export class CustomRolesService {
  constructor(
    @InjectModel(CustomRoleSchemaClass.name)
    private readonly model: Model<CustomRoleDocument>,
    private readonly eventEmitter: EventEmitter2,
    private readonly audit: AuthzAuditService,
    private readonly moduleRef: ModuleRef,
    private readonly cls: ClsService,
  ) {}

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async create(
    tenantId: string,
    dto: CreateCustomRoleDto,
  ): Promise<CustomRole> {
    this.validatePermissions(dto.permissions);
    await this.assertCallerCanGrant(tenantId, dto.permissions);
    await this.assertCallerCanGrantScope(tenantId, dto.dataScope, null);
    const role = new this.model({
      tenantId,
      name: dto.name,
      description: dto.description ?? '',
      permissions: dto.permissions ?? [],
      dataScope: dto.dataScope ?? null,
      color: dto.color ?? '#6366f1',
      revision: 1,
      versions: [
        {
          revision: 1,
          snapshot: this.roleSnapshot(dto),
          publishedAt: new Date(),
          publishedById: this.actorId(),
          sourceRevision: null,
        },
      ],
    });
    const saved = await role.save();
    void this.audit.record({
      category: 'ROLE',
      action: 'create',
      targetType: 'custom_role',
      targetId: String(saved._id),
      summary: `created role "${saved.name}"`,
      after: { name: saved.name, permissions: saved.permissions },
    });
    return CustomRoleMapper.toDomain(saved);
  }

  async findAll(tenantId: string): Promise<CustomRole[]> {
    const rows = await this.model
      .find({ tenantId })
      .sort({ isSystem: -1, name: 1 })
      .lean()
      .exec();
    return CustomRoleMapper.toDomainList(rows);
  }

  /** Look up a materialised system role by its stable template key. */
  async findBySystemKey(
    tenantId: string,
    systemKey: string,
  ): Promise<CustomRole | null> {
    const row = await this.model.findOne({ tenantId, systemKey }).lean().exec();
    return row ? CustomRoleMapper.toDomain(row) : null;
  }

  async findById(id: string, tenantId: string): Promise<CustomRole> {
    const role = (await this.model
      .findOne({ _id: id, tenantId })
      .lean()
      .exec()) as any;
    if (!role) throw new NotFoundException(`Custom role ${id} not found`);
    return CustomRoleMapper.toDomain(role);
  }

  /**
   * Clone any role — including a system one — into a fresh tenant-owned role.
   * This is how a tenant customises a built-in role: the original stays
   * immutable so it can keep receiving central updates.
   */
  async clone(
    id: string,
    tenantId: string,
    dto: CloneCustomRoleDto,
  ): Promise<CustomRole> {
    const source = await this.model
      .findOne({ _id: id, tenantId })
      .lean()
      .exec();
    if (!source) throw new NotFoundException(`Custom role ${id} not found`);

    const baseName = dto.name?.trim() || `Copy of ${source.name}`;
    const name = await this.uniqueName(tenantId, baseName);

    const saved = await this.model.create({
      tenantId,
      name,
      description: source.description ?? '',
      permissions: [...(source.permissions ?? [])],
      // A clone reproduces the source's scope. No escalation check: the source
      // role already exists in this tenant, so copying it grants nothing that
      // was not already grantable — and the clone is only useful as a starting
      // point if it starts equivalent.
      dataScope: source.dataScope ?? null,
      color: source.color,
      // A clone is always tenant-owned and fully editable.
      isSystem: false,
      systemKey: null,
      templateVersion: null,
      revision: 1,
      versions: [
        {
          revision: 1,
          snapshot: this.roleSnapshot({
            name,
            description: source.description ?? '',
            permissions: [...(source.permissions ?? [])],
            dataScope: source.dataScope ?? null,
            color: source.color,
          }),
          publishedAt: new Date(),
          publishedById: this.actorId(),
          sourceRevision: null,
        },
      ],
    });

    void this.audit.record({
      category: 'ROLE',
      action: 'create',
      targetType: 'custom_role',
      targetId: String(saved._id),
      summary: `cloned role "${source.name}" into "${saved.name}"`,
      after: { name: saved.name, permissions: saved.permissions },
    });
    return CustomRoleMapper.toDomain(saved);
  }

  async update(
    id: string,
    tenantId: string,
    dto: UpdateCustomRoleDto,
  ): Promise<CustomRole> {
    const role = await this.model.findOne({ _id: id, tenantId }).exec();
    if (!role) throw new NotFoundException(`Custom role ${id} not found`);

    // System roles are immutable by design — that is what makes central
    // re-syncing of their permission sets safe. Clone to customise.
    if (role.isSystem) {
      throw new BadRequestException(
        'System roles cannot be edited. Clone this role to customise it.',
      );
    }

    if (dto.permissions) {
      this.validatePermissions(dto.permissions);
      // Only the keys being ADDED need to be held by the caller; removing a key
      // is a de-escalation and is always allowed.
      const added = dto.permissions.filter(
        (key) => !role.permissions.includes(key),
      );
      await this.assertCallerCanGrant(tenantId, added);
    }

    if (dto.dataScope !== undefined) {
      await this.assertCallerCanGrantScope(
        tenantId,
        dto.dataScope,
        role.dataScope ?? null,
      );
    }

    const before = { name: role.name, permissions: [...role.permissions] };
    if (!Array.isArray(role.versions) || role.versions.length === 0) {
      role.versions = [
        {
          revision: role.revision ?? 1,
          snapshot: this.roleSnapshot(role as any),
          publishedAt: (role as any).createdAt ?? new Date(),
          publishedById: 'legacy',
          sourceRevision: null,
        },
      ];
    }
    Object.assign(role, dto);
    role.revision = (role.revision ?? 1) + 1;
    role.versions.push({
      revision: role.revision,
      snapshot: this.roleSnapshot(role as any),
      publishedAt: new Date(),
      publishedById: this.actorId(),
      sourceRevision: null,
    });
    const saved = await role.save();
    // A role's permission set changed → any user/group referencing it may now
    // resolve differently. Roles change rarely, so invalidate the whole tenant.
    this.eventEmitter.emit('tenant.permissions.updated', { tenantId });
    void this.audit.record({
      category: 'ROLE',
      action: 'update',
      targetType: 'custom_role',
      targetId: String(saved._id),
      summary: `updated role "${saved.name}"`,
      before,
      after: { name: saved.name, permissions: saved.permissions },
    });
    return CustomRoleMapper.toDomain(saved);
  }

  async remove(id: string, tenantId: string): Promise<void> {
    const role = await this.model.findOne({ _id: id, tenantId }).exec();
    if (!role) throw new NotFoundException(`Custom role ${id} not found`);
    if (role.isSystem) {
      throw new BadRequestException('System roles cannot be deleted');
    }
    await role.deleteOne();
    this.eventEmitter.emit('tenant.permissions.updated', { tenantId });
    void this.audit.record({
      category: 'ROLE',
      action: 'delete',
      targetType: 'custom_role',
      targetId: String(id),
      summary: `deleted role "${role.name}"`,
      before: { name: role.name, permissions: role.permissions },
    });
  }

  async listVersions(id: string, tenantId: string) {
    const role = await this.model
      .findOne({ _id: id, tenantId })
      .select({ versions: 1, revision: 1, isSystem: 1 })
      .lean()
      .exec();
    if (!role) throw new NotFoundException(`Custom role ${id} not found`);
    return {
      currentRevision: role.revision ?? 1,
      versions: role.versions ?? [],
    };
  }

  async rollback(
    id: string,
    tenantId: string,
    sourceRevision: number,
  ): Promise<CustomRole> {
    const role = await this.model.findOne({ _id: id, tenantId }).exec();
    if (!role) throw new NotFoundException(`Custom role ${id} not found`);
    if (role.isSystem) {
      throw new BadRequestException('System roles cannot be rolled back');
    }
    const source = (role.versions ?? []).find(
      (entry) => entry.revision === sourceRevision,
    );
    if (!source) {
      throw new NotFoundException(`Role revision ${sourceRevision} not found`);
    }
    const snapshot = source.snapshot as any;
    this.validatePermissions(snapshot.permissions);
    await this.assertCallerCanGrant(tenantId, snapshot.permissions);
    await this.assertCallerCanGrantScope(
      tenantId,
      snapshot.dataScope,
      role.dataScope,
    );
    Object.assign(role, snapshot);
    role.revision = (role.revision ?? 1) + 1;
    role.versions.push({
      revision: role.revision,
      snapshot: this.roleSnapshot(role as any),
      publishedAt: new Date(),
      publishedById: this.actorId(),
      sourceRevision,
    });
    const saved = await role.save();
    this.eventEmitter.emit('tenant.permissions.updated', { tenantId });
    void this.audit.record({
      category: 'ROLE',
      action: 'update',
      targetType: 'custom_role',
      targetId: String(saved._id),
      summary: `rolled back role to revision ${sourceRevision} as revision ${saved.revision}`,
      after: { sourceRevision, revision: saved.revision },
    });
    return CustomRoleMapper.toDomain(saved);
  }

  // ── Permission matrix ──────────────────────────────────────────────────────

  /**
   * Returns the permission registry grouped by resource, plus the calling
   * tenant's actual ceiling.
   *
   * `allKeys` is the whole registry (what the product can express) while
   * `tenantCeiling` is what THIS tenant is entitled to. The UI must render keys
   * outside the ceiling as unavailable: the engine silently drops them, so
   * without this an admin can grant a permission that never takes effect.
   */
  async getPermissionMatrix(tenantId?: string) {
    const matrix: Record<string, Array<{ action: string; key: string }>> = {};

    for (const [resource, actions] of Object.entries(PERMISSION_REGISTRY)) {
      matrix[resource] = Object.entries(actions)
        .filter(([, key]) => Boolean(key))
        .map(([action, key]) => ({ action, key }));
    }

    const ceiling = await this.resolveTenantCeiling(tenantId);

    return {
      matrix,
      allKeys: ALL_PERMISSIONS,
      /** Keys this tenant may actually use (CORE ∪ granted features ∖ disabled). */
      tenantCeiling: ceiling ? [...ceiling].sort() : ALL_PERMISSIONS,
      /** Baseline every tenant has — anything else is plan-gated. */
      corePermissions: CORE_PERMISSIONS,
      /** Read-only entry the roles UI renders for the ADMIN tenant-role flag. */
      administrator: ADMINISTRATOR_PSEUDO_ROLE,
    };
  }

  private async resolveTenantCeiling(
    tenantId?: string,
  ): Promise<Set<string> | null> {
    if (!tenantId) return null;
    try {
      const tenantsRepository = this.moduleRef.get(TenantsRepository, {
        strict: false,
      });
      const tenant = await tenantsRepository.findById(tenantId);
      if (!tenant) return null;
      const permissionTenant: PermissionTenant = {
        id: String(tenant.id),
        availablePermissions: (tenant as any).availablePermissions ?? null,
        disabledCorePermissions:
          (tenant as any).disabledCorePermissions ?? null,
      };
      return getTenantPermissions(permissionTenant);
    } catch {
      // Never fail the matrix over ceiling resolution — degrade to "everything
      // the registry knows", which is the pre-existing behaviour.
      return null;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * `tenantId + name` is unique, so a clone needs a free name. Appends " (2)",
   * " (3)" … rather than rejecting the request.
   */
  private async uniqueName(tenantId: string, base: string): Promise<string> {
    const trimmed = base.slice(0, 76);
    for (let suffix = 0; suffix < 50; suffix++) {
      const candidate = suffix === 0 ? trimmed : `${trimmed} (${suffix + 1})`;
      const taken = await this.model.exists({ tenantId, name: candidate });
      if (!taken) return candidate;
    }
    throw new BadRequestException(
      `Too many roles named like "${base}" — pick a different name.`,
    );
  }

  private actorId(): string {
    return String(this.cls.get<string>('userId') ?? 'system');
  }

  private roleSnapshot(input: Record<string, any>): Record<string, unknown> {
    return {
      name: input.name,
      description: input.description ?? '',
      permissions: [...(input.permissions ?? [])],
      dataScope: input.dataScope ?? null,
      color: input.color ?? '#6366f1',
    };
  }

  private validatePermissions(permissions?: string[]) {
    if (!permissions?.length) return;
    const invalid = permissions.filter((p) => !ALL_PERMISSIONS.includes(p));
    if (invalid.length) {
      throw new BadRequestException(
        `Unknown permission keys: ${invalid.join(', ')}`,
      );
    }
  }

  /**
   * The anti-escalation invariant for the role path (C-04).
   *
   * Registry validation only rejects typos — it does nothing to stop a holder of
   * `roles:update` from adding every key in the product to a role and assigning
   * it to themselves. A role is a permission container, so creating or editing
   * one is a grant and is bound by the same rule as a direct grant:
   *
   *   requested ⊆ callerEffective
   *
   * Owner / admin / super-admin hold the full ceiling and pass trivially.
   */
  private async assertCallerCanGrant(
    tenantId: string,
    permissions?: string[],
  ): Promise<void> {
    if (!permissions?.length) return;

    const callerId = this.cls.get<string>('userId');
    if (!callerId) {
      throw new ForbiddenException(
        'Cannot resolve the acting principal; role permission change refused',
      );
    }

    // Resolved lazily: AuthzPermissionCacheService depends on this service, so
    // a constructor injection would be a circular dependency. Keyed on a token
    // rather than the class so the module graph stays acyclic too — see
    // ./authz.tokens.
    const authzCache = this.moduleRef.get<AuthzPermissionCacheService>(
      AUTHZ_PERMISSION_CACHE,
      { strict: false },
    );
    const explanation = await authzCache.explainForUser(
      String(callerId),
      tenantId,
    );

    const held = explanation.fullAccess
      ? new Set(explanation.tenantCeiling)
      : new Set(explanation.effective);

    const escalating = [...new Set(permissions)].filter(
      (key) => !held.has(key),
    );

    if (escalating.length) {
      throw new ForbiddenException(
        `You cannot grant permission(s) you do not hold yourself: ${escalating.join(', ')}`,
      );
    }
  }

  /**
   * The same invariant on the OTHER axis a role grants.
   *
   * A role carries permissions *and* a data scope, and widening the scope is an
   * escalation even when the permission set is untouched: an ORG_UNIT manager
   * who can author roles could otherwise mint "Sales Rep (tenant scope)", assign
   * it to themselves, and read the whole workspace while every permission key
   * stayed within what they already hold. Guarding only `permissions` would
   * leave that door open.
   *
   * Only *widening* is checked. Lowering a role's scope is de-escalation and is
   * always allowed, mirroring how removing a permission key is.
   */
  private async assertCallerCanGrantScope(
    tenantId: string,
    requested: DataScope | null | undefined,
    current: DataScope | null | undefined,
  ): Promise<void> {
    if (!requested) return;
    if (current && !scopeAtLeast(requested, current)) return; // narrowing
    if (current === requested) return;

    const callerId = this.cls.get<string>('userId');
    if (!callerId) {
      throw new ForbiddenException(
        'Cannot resolve the acting principal; role scope change refused',
      );
    }

    const authzCache = this.moduleRef.get<AuthzPermissionCacheService>(
      AUTHZ_PERMISSION_CACHE,
      { strict: false },
    );
    const { scope: held } = await authzCache.resolveDataScope(
      String(callerId),
      tenantId,
    );

    if (!scopeAtLeast(held, requested)) {
      throw new ForbiddenException(
        `You cannot grant data scope "${requested}"; your own scope is "${held}"`,
      );
    }
  }
}
