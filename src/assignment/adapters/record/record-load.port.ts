import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { AssignmentScope, LoadPort } from '../../core/ports';
import { AssignmentStrategy } from '../../domain/assignment.types';
import { ZsetReservationService } from '../../infrastructure/reservation/zset-reservation.service';

/**
 * Which collection holds an objectType, and what counts as *open* work.
 *
 * `activeFilter` is what makes capacity mean "current workload" rather than
 * "everything ever owned". Without it an agent who closed a thousand tickets
 * looks permanently full — which is exactly what happened while these filters
 * were written against a `status` string field that no schema had: the filter
 * matched every document, so capacity equalled lifetime-owned count and
 * auto-assignment was silently dead.
 */
interface ObjectTypeLoadSource {
  collection: string;
  activeFilter?: Record<string, unknown>;
}

const LOAD_SOURCES: Record<string, ObjectTypeLoadSource> = {
  // Lead and Contact share the contacts collection; the lifecycle stage
  // distinguishes them, and open-ness is not a meaningful axis for either, so
  // "load" is simply how many the person owns.
  Lead: {
    collection: 'contacts',
    activeFilter: { deletedAt: { $exists: false } },
  },
  Contact: {
    collection: 'contacts',
    activeFilter: { deletedAt: { $exists: false } },
  },
  Account: {
    collection: 'accounts',
    activeFilter: { deletedAt: { $exists: false } },
  },
  Ticket: {
    collection: 'tickets',
    activeFilter: {
      deletedAt: { $exists: false },
      closedAt: { $exists: false },
    },
  },
  Task: {
    collection: 'tasks',
    activeFilter: {
      deletedAt: { $exists: false },
      completedAt: { $exists: false },
    },
  },
  Deal: {
    collection: 'deals',
    // `stageId` is pipeline-specific and cannot be filtered generically; the
    // won/lost timestamps are the reliable closed indicators.
    activeFilter: {
      deletedAt: { $exists: false },
      wonAt: { $exists: false },
      lostAt: { $exists: false },
    },
  },
};

function toObjectId(id: string): Types.ObjectId | string {
  return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : id;
}

/**
 * Load and reservation for CRM records.
 *
 * MongoDB is the source of truth for the *initial* count; Redis is authoritative
 * once seeded, so concurrent decisions increment the same counter instead of
 * each reading the same stale aggregate. That is the difference from the old
 * `CapacityFilterService`, which re-counted in Mongo on every decision and never
 * reserved: two simultaneous assignments always picked the same person.
 */
@Injectable()
export class RecordLoadPort implements LoadPort {
  private readonly logger = new Logger(RecordLoadPort.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly reservation: ZsetReservationService,
  ) {}

  /**
   * Capacity belongs to a person, so the load key ignores team and channel.
   * Keying it per team, as the old engine did, makes someone on two teams look
   * half-loaded on each.
   */
  private loadScope(scope: AssignmentScope): string {
    return `${scope.tenantId}:${scope.objectType}`;
  }

  /** Rotation is fair within a team, so the cursor key includes it. */
  private cursorScope(scope: AssignmentScope): string {
    return `${scope.tenantId}:${scope.objectType}:${scope.scopeId ?? '-'}:${
      scope.groupId ?? '-'
    }`;
  }

  /**
   * Count open work per candidate straight from the owning collection.
   *
   * Exposed separately from `loads()` because it is also the seed source and the
   * drift-correction source: Redis counters are reconciled against this.
   */
  async countOpenWork(
    scope: AssignmentScope,
    candidateIds: string[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const id of candidateIds) result.set(id, 0);

    const source = LOAD_SOURCES[scope.objectType];
    if (!source) {
      this.logger.warn(
        `No load source configured for ${scope.objectType} — treating every candidate as idle`,
      );
      return result;
    }

    try {
      const rows = await this.connection
        .collection(source.collection)
        .aggregate([
          {
            $match: {
              tenantId: toObjectId(scope.tenantId),
              ownerId: { $in: candidateIds.map(toObjectId) },
              ...(source.activeFilter ?? {}),
            },
          },
          { $group: { _id: '$ownerId', count: { $sum: 1 } } },
        ])
        .toArray();

      for (const row of rows) {
        if (row._id) result.set(String(row._id), row.count as number);
      }
    } catch (err: any) {
      this.logger.error(
        `Failed to count open ${scope.objectType} per owner: ${err.message}`,
      );
    }
    return result;
  }

  /**
   * Seed Redis from Mongo for any unseeded candidate, then return the live Redis
   * scores. Seeding is `ZADD NX`, so a candidate already tracked keeps the score
   * reservations have moved.
   */
  private async seedAndRead(
    scope: AssignmentScope,
    candidateIds: string[],
  ): Promise<Map<string, number>> {
    if (candidateIds.length === 0) return new Map();
    const loadScope = this.loadScope(scope);
    const mongoLoads = await this.countOpenWork(scope, candidateIds);
    await this.reservation.seed(loadScope, mongoLoads);
    return this.reservation.scores(loadScope, candidateIds);
  }

  async loads(
    scope: AssignmentScope,
    candidateIds: string[],
  ): Promise<Map<string, number>> {
    return this.seedAndRead(scope, candidateIds);
  }

  async rotate(
    scope: AssignmentScope,
    candidateIds: string[],
  ): Promise<string[]> {
    return this.reservation.rotate(this.cursorScope(scope), candidateIds);
  }

  async reserve(
    scope: AssignmentScope,
    orderedCandidateIds: string[],
    strategy: AssignmentStrategy,
    maxCapacity: number,
  ): Promise<string | null> {
    // Seed before reserving: the Lua scripts skip members with no score, so an
    // unseeded candidate would be invisible and a fresh pool would never be
    // assigned to at all.
    await this.seedAndRead(scope, orderedCandidateIds);
    return this.reservation.reserve(
      {
        loadScope: this.loadScope(scope),
        cursorScope: this.cursorScope(scope),
        commandId: scope.commandId,
      },
      orderedCandidateIds,
      strategy,
      maxCapacity,
    );
  }

  async preview(
    scope: AssignmentScope,
    orderedCandidateIds: string[],
    strategy: AssignmentStrategy,
    maxCapacity: number,
  ): Promise<string | null> {
    await this.seedAndRead(scope, orderedCandidateIds);
    return this.reservation.preview(
      this.loadScope(scope),
      orderedCandidateIds,
      strategy,
      maxCapacity,
    );
  }

  async release(scope: AssignmentScope, candidateId: string): Promise<void> {
    await this.reservation.release(
      this.loadScope(scope),
      candidateId,
      scope.commandId,
    );
  }

  async complete(scope: AssignmentScope, _candidateId: string): Promise<void> {
    await this.reservation.completeLease(scope.commandId);
  }

  async reconcileTrackedScope(
    scope: AssignmentScope,
  ): Promise<{ candidates: number; drifted: number; absoluteDrift: number }> {
    const loadScope = this.loadScope(scope);
    const candidateIds = await this.reservation.trackedMembers(loadScope);
    if (candidateIds.length === 0) {
      return { candidates: 0, drifted: 0, absoluteDrift: 0 };
    }
    const [stored, actual] = await Promise.all([
      this.reservation.scores(loadScope, candidateIds),
      this.countOpenWork(scope, candidateIds),
    ]);
    let drifted = 0;
    let absoluteDrift = 0;
    for (const id of candidateIds) {
      const delta = (stored.get(id) ?? 0) - (actual.get(id) ?? 0);
      if (delta !== 0) {
        drifted++;
        absoluteDrift += Math.abs(delta);
      }
    }
    if (drifted > 0) {
      await this.reservation.overwriteTracked(loadScope, actual);
    }
    return { candidates: candidateIds.length, drifted, absoluteDrift };
  }
}
