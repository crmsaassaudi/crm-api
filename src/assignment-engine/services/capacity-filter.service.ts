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

  // Module → { collection name, optional activeFilter } mapping.
  //
  // activeFilter excludes already-closed entities so capacity reflects *open*
  // work only (HIGH-03). Without it, an agent who closed 1000 tickets would be
  // counted as fully loaded forever.
  //
  // NOTE: status field names/values below are best-effort for the common CRM
  // schema. Ticket statuses (closed/resolved) are the most reliable; deal/task
  // filters are conservative and may need tuning if a tenant uses custom
  // pipelines. Where unsure we leave activeFilter undefined (count everything),
  // which preserves the previous behaviour for that module.
  private static readonly MODULE_COLLECTION_MAP: Record<
    string,
    { collection: string; activeFilter?: Record<string, any> }
  > = {
    Contact: { collection: 'contacts' },
    Ticket: {
      collection: 'tickets',
      // Exclude terminal ticket states.
      activeFilter: { status: { $nin: ['closed', 'resolved'] } },
    },
    Task: {
      collection: 'tasks',
      // Exclude completed tasks.
      activeFilter: { status: { $nin: ['done', 'completed'] } },
    },
    Deal: {
      collection: 'deals',
      // Exclude won/lost deals if the schema tracks a coarse stage status.
      // `stage` is free-form per pipeline, so we filter on a normalized
      // `status`/`isClosed` style field when present and otherwise count all.
      activeFilter: { status: { $nin: ['won', 'lost', 'closed'] } },
    },
  };

  constructor(@InjectConnection() private readonly connection: Connection) {}

  /**
   * Filter candidates by capacity, skills, and availability.
   *
   * Returns the eligible user IDs together with the `loadMap` computed during
   * the capacity check, so the caller (least-busy strategy) can reuse it
   * instead of querying Mongo a second time (HIGH-04).
   */
  async filterEligible(
    tenantId: string,
    module: string,
    candidateIds: string[],
    maxCapacity: number,
    requiredSkills?: string[],
  ): Promise<{ eligible: string[]; loadMap: Map<string, number> }> {
    if (candidateIds.length === 0) {
      return { eligible: [], loadMap: new Map() };
    }

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

    return { eligible, loadMap };
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

    const moduleConfig = CapacityFilterService.MODULE_COLLECTION_MAP[module];
    if (!moduleConfig) {
      this.logger.warn(`Unknown module for capacity check: ${module}`);
      return loadMap;
    }

    try {
      const collection = this.connection.collection(moduleConfig.collection);
      const objectIds = userIds.map((id) => this.toObjectId(id));

      const results = await collection
        .aggregate([
          {
            $match: {
              tenantId: this.toObjectId(tenantId),
              ownerId: { $in: objectIds },
              // HIGH-03: count only OPEN work, not lifetime-owned entities.
              ...(moduleConfig.activeFilter ?? {}),
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
