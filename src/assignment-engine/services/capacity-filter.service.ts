import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { AgentPresenceService } from '../../omni-inbound/services/agent-presence.service';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';

/**
 * CapacityFilterService — filters candidate agents by:
 *   1. Capacity: activeEntityCount < maxCapacity
 *   2. Skills: user.skills ⊇ requiredSkills (matched by apiName)
 *   3. Presence: online agents preferred/required per module (Phase 3.3)
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
  // work only. Without it, an agent who closed 1000 tickets would be
  // counted as fully loaded forever.
  //
  // CRIT-09: Previous filters used a non-existent `status` string field.
  // Tickets/Tasks use `statusId` (ObjectId ref), Deals use `stageId`/`wonAt`/`lostAt`.
  // The old `{ status: { $nin: [...] } }` matched EVERY document (field didn't exist),
  // making capacity = lifetime-owned count → auto-assignment permanently broken.
  //
  // Fix: Use real schema fields — exclude soft-deleted + closed entities.
  private static readonly MODULE_COLLECTION_MAP: Record<
    string,
    { collection: string; activeFilter?: Record<string, any> }
  > = {
    Contact: { collection: 'contacts' },
    Ticket: {
      collection: 'tickets',
      // Exclude soft-deleted tickets; isClosed denormalized flag or
      // filter by deletedAt as the reliable closed indicator.
      activeFilter: {
        deletedAt: { $exists: false },
        isClosed: { $ne: true },
      },
    },
    Task: {
      collection: 'tasks',
      // Exclude soft-deleted and completed tasks.
      activeFilter: {
        deletedAt: { $exists: false },
        isClosed: { $ne: true },
      },
    },
    Deal: {
      collection: 'deals',
      // Exclude won/lost deals — these have `wonAt` or `lostAt` set.
      // `stageId` is pipeline-specific so we can't filter by it generically.
      activeFilter: {
        wonAt: { $exists: false },
        lostAt: { $exists: false },
        deletedAt: { $exists: false },
      },
    },
  };

  /** Maps CRM module names to omni_presence.requireOnlineForAssignment keys. */
  private static readonly MODULE_PRESENCE_KEY: Record<string, string> = {
    Ticket: 'ticket',
    Task: 'task',
    Deal: 'deal',
    Contact: 'contact',
  };

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly presenceService: AgentPresenceService,
    private readonly settingsService: CrmSettingsService,
  ) {}

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

    // 3. Phase 3.3: Filter/sort by online presence
    eligible = await this.filterByPresence(tenantId, module, eligible);

    return { eligible, loadMap };
  }

  /**
   * Phase 3.3: Filter or prioritize candidates based on their online presence.
   *
   * Reads `omni_presence.requireOnlineForAssignment[module]`:
   *   - true  → EXCLUDE candidates who are not AVAILABLE+CONNECTED
   *   - false → SORT online agents first, but keep offline agents in the list
   */
  private async filterByPresence(
    tenantId: string,
    module: string,
    candidateIds: string[],
  ): Promise<string[]> {
    if (candidateIds.length === 0) return candidateIds;

    const presenceKey = CapacityFilterService.MODULE_PRESENCE_KEY[module];
    if (!presenceKey) return candidateIds;

    let requireOnline = false;
    try {
      const cfg = await this.settingsService.getSetting('omni_presence', tenantId);
      const requireMap = (cfg as any)?.requireOnlineForAssignment;
      if (requireMap && typeof requireMap[presenceKey] === 'boolean') {
        requireOnline = requireMap[presenceKey];
      }
    } catch {
      // fallback: don't require online
    }

    // Get all agent presences in one batch
    const presences = await this.presenceService.getAllAgents(tenantId);
    const onlineSet = new Set<string>();
    for (const p of presences) {
      if (
        p.presenceStatus === 'AVAILABLE' &&
        p.connectionStatus === 'CONNECTED'
      ) {
        onlineSet.add(p.userId);
      }
    }

    if (requireOnline) {
      // Hard filter: only online agents
      const filtered = candidateIds.filter((id) => onlineSet.has(id));
      this.logger.debug(
        `Presence filter [${module}] (require=true): ${candidateIds.length} → ${filtered.length} online`,
      );
      return filtered;
    }

    // Soft sort: online agents first, then offline
    const online: string[] = [];
    const offline: string[] = [];
    for (const id of candidateIds) {
      if (onlineSet.has(id)) {
        online.push(id);
      } else {
        offline.push(id);
      }
    }
    this.logger.debug(
      `Presence sort [${module}] (require=false): ${online.length} online + ${offline.length} offline`,
    );
    return [...online, ...offline];
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
