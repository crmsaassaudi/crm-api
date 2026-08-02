import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  UserSchemaClass,
  UserSchemaDocument,
} from '../users/infrastructure/persistence/document/entities/user.schema';

/**
 * Resolves the reporting hierarchy for Role-based data visibility.
 *
 * Uses the `reportsToId` field on User to build a manager→subordinate tree.
 * This is the "Reports To" pattern (like Salesforce) — simple, flat, no
 * separate tree table.
 *
 * Performance:
 *  - Loads all users for the tenant in a single query (lean, projected).
 *  - Builds the tree in memory — fast for typical tenant sizes (< 10K users).
 *  - Results should be cached at the request level (CLS) by the interceptor.
 */
@Injectable()
export class RoleHierarchyService {
  private readonly logger = new Logger(RoleHierarchyService.name);

  constructor(
    @InjectModel(UserSchemaClass.name)
    private readonly userModel: Model<UserSchemaDocument>,
  ) {}

  /**
   * Returns all user IDs that are subordinates of the given user,
   * at any depth in the hierarchy.
   *
   * @param tenantId - Current tenant context
   * @param userId   - The manager user ID
   * @returns Array of subordinate user IDs (does NOT include the user itself)
   */
  async getSubordinateIds(tenantId: string, userId: string): Promise<string[]> {
    // The manager chain is per-membership, so project only the matching
    // membership: `tenants.$` returns the one element that satisfied the
    // filter, and reading `tenants[0]` off a multi-tenant user would otherwise
    // hand back whichever workspace happens to sit first in the array.
    const users = await this.userModel
      .find({ 'tenants.tenantId': tenantId }, { _id: 1, 'tenants.$': 1 })
      .lean()
      .exec();

    // Build adjacency list: managerId → [directReportIds]
    const childrenMap = new Map<string, string[]>();
    for (const user of users) {
      const reportsToId = (user.tenants?.[0] as any)?.reportsToId;
      if (reportsToId) {
        const managerId = reportsToId.toString();
        if (!childrenMap.has(managerId)) {
          childrenMap.set(managerId, []);
        }
        childrenMap.get(managerId)!.push(user._id.toString());
      }
    }

    // BFS to find all subordinates at any depth
    const subordinates: string[] = [];
    const queue = childrenMap.get(userId) || [];
    const visited = new Set<string>([userId]);

    let idx = 0;
    while (idx < queue.length) {
      const current = queue[idx++];
      if (visited.has(current)) continue; // Prevent cycles
      visited.add(current);
      subordinates.push(current);

      const children = childrenMap.get(current) || [];
      for (const child of children) {
        if (!visited.has(child)) {
          queue.push(child);
        }
      }
    }

    return subordinates;
  }

  /**
   * Returns all user IDs whose data the given user should be able to see.
   * = [self] + [all subordinates]
   *
   * Admin/Owner bypass is handled by the caller (interceptor), not here.
   */
  async getVisibleOwnerIds(
    tenantId: string,
    userId: string,
  ): Promise<string[]> {
    const subordinates = await this.getSubordinateIds(tenantId, userId);
    return [userId, ...subordinates];
  }
}
