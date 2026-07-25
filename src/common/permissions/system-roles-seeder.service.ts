import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import {
  CustomRoleSchemaClass,
  CustomRoleDocument,
} from './custom-role.schema';
import {
  SYSTEM_ROLE_TEMPLATES,
  SystemRoleTemplate,
  resolveTemplatePermissions,
} from './system-role-templates';
import { getTenantPermissions, PermissionTenant } from './permission.engine';
import { TenantsRepository } from '../../tenants/infrastructure/persistence/document/repositories/tenant.repository';

export interface SystemRolesSyncResult {
  tenantId: string;
  created: string[];
  updated: string[];
  unchanged: string[];
  skipped: string[];
}

/**
 * Materialises SYSTEM_ROLE_TEMPLATES into a tenant's `custom_roles`.
 *
 * Runs on tenant creation, and again from `npm run seed:system-roles` to
 * backfill tenants that existed before this feature — both paths are fully
 * idempotent and keyed on `systemKey`, never on the display name.
 */
@Injectable()
export class SystemRolesSeederService {
  private readonly logger = new Logger(SystemRolesSeederService.name);

  constructor(
    @InjectModel(CustomRoleSchemaClass.name)
    private readonly model: Model<CustomRoleDocument>,
    private readonly moduleRef: ModuleRef,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Create missing system roles and re-sync outdated ones for one tenant.
   *
   * Re-syncing is only safe because system roles are immutable through the API:
   * there is never a tenant edit to overwrite.
   */
  async ensureForTenant(tenantId: string): Promise<SystemRolesSyncResult> {
    const result: SystemRolesSyncResult = {
      tenantId,
      created: [],
      updated: [],
      unchanged: [],
      skipped: [],
    };

    const ceiling = await this.resolveCeiling(tenantId);
    if (!ceiling) {
      this.logger.warn(
        `Skipping system-role seeding: tenant ${tenantId} not found`,
      );
      return result;
    }

    const existingRows = await this.model
      .find({ tenantId, systemKey: { $type: 'string' } })
      .exec();
    const bySystemKey = new Map(
      existingRows.map((row) => [String(row.systemKey), row]),
    );

    for (const template of SYSTEM_ROLE_TEMPLATES) {
      const existing = bySystemKey.get(template.systemKey);

      // Feature-gated role the tenant isn't entitled to. Never create it; an
      // already-materialised one is left alone so a temporary plan downgrade
      // doesn't destroy assignments.
      if (
        template.requiresFeature &&
        !ceiling.has(template.requiresFeature) &&
        !existing
      ) {
        result.skipped.push(template.systemKey);
        continue;
      }

      const permissions = resolveTemplatePermissions(template, ceiling);

      if (!existing) {
        await this.createRow(tenantId, template, permissions);
        result.created.push(template.systemKey);
        continue;
      }

      if (this.isUpToDate(existing, template, permissions)) {
        result.unchanged.push(template.systemKey);
        continue;
      }

      // `name` is deliberately left as-is: it may carry the "(System)" suffix
      // from a collision, and admins refer to these roles by name.
      existing.set({
        description: template.description,
        color: template.color,
        permissions,
        isSystem: true,
        templateVersion: template.version,
      });
      await existing.save();
      result.updated.push(template.systemKey);
    }

    if (result.created.length || result.updated.length) {
      // Permission sets behind existing roleIds changed → drop cached grants.
      this.eventEmitter.emit('tenant.permissions.updated', { tenantId });
      this.logger.log(
        `System roles for tenant ${tenantId}: +${result.created.length} created, ${result.updated.length} re-synced`,
      );
    }

    return result;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private isUpToDate(
    existing: CustomRoleDocument,
    template: SystemRoleTemplate,
    permissions: string[],
  ): boolean {
    if ((existing.templateVersion ?? 0) < template.version) return false;
    // Dynamic roles (Read Only) track the tenant ceiling, which moves on plan
    // changes without any template version bump.
    const current = [...(existing.permissions ?? [])].sort();
    const next = [...permissions].sort();
    return (
      current.length === next.length &&
      current.every((key, index) => key === next[index])
    );
  }

  private async createRow(
    tenantId: string,
    template: SystemRoleTemplate,
    permissions: string[],
  ): Promise<void> {
    // `tenantId + name` is unique, and a tenant may already have hand-made a
    // role called e.g. "Manager". Suffix rather than fail the whole seeding run.
    const nameTaken = await this.model
      .exists({ tenantId, name: template.name })
      .exec();
    const name = nameTaken ? `${template.name} (System)` : template.name;

    await this.model.create({
      tenantId,
      systemKey: template.systemKey,
      templateVersion: template.version,
      isSystem: true,
      name,
      description: template.description,
      color: template.color,
      permissions,
    });
  }

  /**
   * The tenant's permission ceiling (CORE ∪ availablePermissions ∖ disabled).
   * TenantsRepository is resolved lazily: AuthorizationModule is @Global and
   * loads before TenantsModule, so a constructor injection would be a cycle.
   */
  private async resolveCeiling(tenantId: string): Promise<Set<string> | null> {
    const tenantsRepository = this.moduleRef.get(TenantsRepository, {
      strict: false,
    });
    const tenant = await tenantsRepository.findById(tenantId);
    if (!tenant) return null;

    const permissionTenant: PermissionTenant = {
      id: String(tenant.id),
      ownerId: (tenant as any).ownerId ?? null,
      availablePermissions: (tenant as any).availablePermissions ?? null,
      disabledCorePermissions: (tenant as any).disabledCorePermissions ?? null,
    };
    return getTenantPermissions(permissionTenant);
  }
}
