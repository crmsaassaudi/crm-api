import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';

/**
 * CapacityFilterService — filters candidate agents by:
 *   1. Capacity: activeEntityCount < maxCapacity
 *   2. Skills: user.skills ⊇ requiredSkills (matched by apiName)
 *
 * Uses Mongoose Connection to dynamically access CRM entity models
 * (avoids circular module dependencies).
 *
 * Phase 1: Lightweight capacity = simple count query per module.
 * Future: weighted capacity (Deal $1M = weight 3).
 */
@Injectable()
export class CapacityFilterService {
  private readonly logger = new Logger(CapacityFilterService.name);

  // Module → Mongoose collection name mapping
  private static readonly MODULE_COLLECTION_MAP: Record<string, string> = {
    Contact: 'contacts',
    Ticket: 'tickets',
    Task: 'tasks',
    Deal: 'deals',
  };

  constructor(@InjectConnection() private readonly connection: Connection) {}

  /**
   * Filter candidates by capacity, skills, and availability.
   * Returns list of user IDs that are eligible for assignment.
   */
  async filterEligible(
    tenantId: string,
    module: string,
    candidateIds: string[],
    maxCapacity: number,
    requiredSkills?: string[],
  ): Promise<string[]> {
    if (candidateIds.length === 0) return [];

    // 1. Check capacity: count active entities per candidate
    const loadMap = await this.getActiveLoads(tenantId, module, candidateIds);
    let eligible = candidateIds.filter((id) => {
      const load = loadMap.get(id) ?? 0;
      return load < maxCapacity;
    });

    this.logger.debug(
      `Capacity filter [${module}]: ${candidateIds.length} candidates → ${eligible.length} under capacity (max=${maxCapacity})`,
    );

    // 2. Check skills if required
    if (requiredSkills && requiredSkills.length > 0 && eligible.length > 0) {
      const userCollection = this.connection.collection('users');
      const objectIdList = eligible
        .map((id) => this.toObjectId(id))
        .filter((v): v is Types.ObjectId => v instanceof Types.ObjectId);
      const users = await userCollection
        .find({
          _id: { $in: objectIdList },
        })
        .project({ _id: 1, skills: 1 })
        .toArray();

      eligible = users
        .filter((user: any) => {
          const userSkills = (user.skills ?? []).map((s: string) =>
            s.toLowerCase(),
          );
          return requiredSkills.every((skill) =>
            userSkills.includes(skill.toLowerCase()),
          );
        })
        .map((user: any) => user._id.toString());

      this.logger.debug(
        `Skills filter [${module}]: ${requiredSkills.join(',')} → ${eligible.length} candidates with matching skills`,
      );
    }

    return eligible;
  }

  /**
   * Build a load map: userId → count of active entities they own.
   * Uses native MongoDB collection access to avoid module coupling.
   */
  async getActiveLoads(
    tenantId: string,
    module: string,
    userIds: string[],
  ): Promise<Map<string, number>> {
    const loadMap = new Map<string, number>();

    // Initialize all to 0
    for (const id of userIds) {
      loadMap.set(id, 0);
    }

    const collName = CapacityFilterService.MODULE_COLLECTION_MAP[module];
    if (!collName) {
      this.logger.warn(`Unknown module for capacity check: ${module}`);
      return loadMap;
    }

    try {
      const collection = this.connection.collection(collName);
      const objectIds = userIds.map((id) => this.toObjectId(id));

      const results = await collection
        .aggregate([
          {
            $match: {
              tenantId: this.toObjectId(tenantId),
              ownerId: { $in: objectIds },
            },
          },
          { $group: { _id: '$ownerId', count: { $sum: 1 } } },
        ])
        .toArray();

      for (const r of results) {
        if (r._id) loadMap.set(r._id.toString(), r.count);
      }
    } catch (err: any) {
      this.logger.error(
        `Failed to count active entities for ${module}: ${err.message}`,
      );
    }

    return loadMap;
  }

  private toObjectId(id: string): Types.ObjectId | string {
    try {
      return new Types.ObjectId(id);
    } catch {
      return id;
    }
  }
}
