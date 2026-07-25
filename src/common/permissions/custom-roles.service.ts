import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ModuleRef } from '@nestjs/core';
import { Model } from 'mongoose';
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
import { ADMINISTRATOR_PSEUDO_ROLE } from './system-role-templates';
import { CustomRole } from './domain/custom-role';
import { CustomRoleMapper } from './mappers/custom-role.mapper';
import { AuthzAuditService } from '../authz-audit/authz-audit.service';
import { TenantsRepository } from '../../tenants/infrastructure/persistence/document/repositories/tenant.repository';

@Injectable()
export class CustomRolesService {
  constructor(
    @InjectModel(CustomRoleSchemaClass.name)
    private readonly model: Model<CustomRoleDocument>,
    private readonly eventEmitter: EventEmitter2,
    private readonly audit: AuthzAuditService,
    private readonly moduleRef: ModuleRef,
  ) {}

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async create(
    tenantId: string,
    dto: CreateCustomRoleDto,
  ): Promise<CustomRole> {
    this.validatePermissions(dto.permissions);
    const role = new this.model({
      tenantId,
      name: dto.name,
      description: dto.description ?? '',
      permissions: dto.permissions ?? [],
      color: dto.color ?? '#6366f1',
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
      color: source.color,
      // A clone is always tenant-owned and fully editable.
      isSystem: false,
      systemKey: null,
      templateVersion: null,
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

    if (dto.permissions) this.validatePermissions(dto.permissions);

    const before = { name: role.name, permissions: [...role.permissions] };
    Object.assign(role, dto);
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

  private validatePermissions(permissions?: string[]) {
    if (!permissions?.length) return;
    const invalid = permissions.filter((p) => !ALL_PERMISSIONS.includes(p));
    if (invalid.length) {
      throw new BadRequestException(
        `Unknown permission keys: ${invalid.join(', ')}`,
      );
    }
  }
}
