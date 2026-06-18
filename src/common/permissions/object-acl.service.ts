import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ObjectAcl, ObjectAclDocument } from './object-acl.schema';

export interface AclEntry {
  resourceType: string;
  resourceId: string;
  principalType: 'user' | 'group';
  principalId: string;
  permissions: string[];
  isDeny?: boolean;
  tenantId: string;
}

/**
 * ObjectAclService — record-level access control.
 *
 * Layered on top of the existing PermissionEngine (resource-level checks).
 * Use this when you need per-record access (e.g. "can Alice view THIS deal?").
 *
 * Resolution order:
 *   1. Explicit deny entries always win.
 *   2. Allow entries are union-merged across all matching principals.
 *   3. No entry → falls back to PermissionEngine (resource-level default).
 *
 * Usage in a controller:
 *   @UseGuards(AclGuard)
 *   @UseAcl('edit', 'deals')
 *   async updateDeal(...) {}
 */
@Injectable()
export class ObjectAclService {
  private readonly logger = new Logger(ObjectAclService.name);

  constructor(
    @InjectModel(ObjectAcl.name)
    private readonly aclModel: Model<ObjectAclDocument>,
  ) {}

  // ── Read ────────────────────────────────────────────────────────────────

  /**
   * Returns all ACL entries for a specific resource record.
   */
  async getForResource(
    tenantId: string,
    resourceType: string,
    resourceId: string,
  ): Promise<ObjectAcl[]> {
    return this.aclModel
      .find({ tenantId, resourceType, resourceId })
      .lean()
      .exec();
  }

  /**
   * Returns all resources of a given type that this principal can access.
   */
  async getGrantedResources(
    tenantId: string,
    principalId: string,
    resourceType: string,
    action: string,
  ): Promise<string[]> {
    const entries = await this.aclModel
      .find({
        tenantId,
        principalId,
        resourceType,
        permissions: action,
        isDeny: { $ne: true },
      })
      .lean()
      .exec();
    return entries.map((e) => e.resourceId);
  }

  // ── Check ───────────────────────────────────────────────────────────────

  /**
   * Core ACL check: can `principalId` perform `action` on `resourceId`?
   *
   * @param groupIds    Additional group IDs the user belongs to (for group grants).
   * @returns           true = explicit allow, false = explicit deny, null = no ACL entry (fallback to resource-level)
   */
  async can(
    tenantId: string,
    principalId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    groupIds: string[] = [],
  ): Promise<boolean | null> {
    const principalIds = [principalId, ...groupIds];

    const entries = await this.aclModel
      .find({
        tenantId,
        resourceType,
        resourceId,
        principalId: { $in: principalIds },
      })
      .lean()
      .exec();

    if (entries.length === 0) return null; // no entry → fallback

    // Explicit deny wins
    const hasDeny = entries.some(
      (e) => e.isDeny && e.permissions.includes(action),
    );
    if (hasDeny) return false;

    // Allow if any entry grants the action
    const hasAllow = entries.some(
      (e) => !e.isDeny && e.permissions.includes(action),
    );
    return hasAllow ? true : null;
  }

  // ── Write ───────────────────────────────────────────────────────────────

  /**
   * Upserts an ACL entry. Uses principalId + resourceId + resourceType + principalType as key.
   */
  async upsert(entry: AclEntry): Promise<ObjectAcl> {
    const { resourceType, resourceId, principalType, principalId, tenantId } =
      entry;
    return this.aclModel
      .findOneAndUpdate(
        { resourceType, resourceId, principalType, principalId, tenantId },
        {
          $set: {
            permissions: entry.permissions,
            isDeny: entry.isDeny ?? false,
          },
        },
        { upsert: true, new: true },
      )
      .lean()
      .exec() as Promise<ObjectAcl>;
  }

  /**
   * Removes a single ACL entry.
   */
  async remove(
    tenantId: string,
    resourceType: string,
    resourceId: string,
    principalId: string,
  ): Promise<void> {
    await this.aclModel
      .deleteOne({ tenantId, resourceType, resourceId, principalId })
      .exec();
  }

  /**
   * Removes ALL ACL entries for a resource (use on record delete).
   */
  async removeAllForResource(
    tenantId: string,
    resourceType: string,
    resourceId: string,
  ): Promise<void> {
    await this.aclModel
      .deleteMany({ tenantId, resourceType, resourceId })
      .exec();
    this.logger.debug(`Purged ACL for ${resourceType}/${resourceId}`);
  }
}
