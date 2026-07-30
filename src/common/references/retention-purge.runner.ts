import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import {
  EntityReference,
  buildDetachUpdate,
  buildReferenceFilter,
} from './entity-reference';

/** What a purge needs from a domain's repository, and nothing more. */
export interface PurgeableRepository {
  findPurgeable(
    cutoff: Date,
    limit: number,
  ): Promise<Array<{ id: string; tenantId: string }>>;
  hardDelete(id: string): Promise<void>;
}

export interface RetentionPurgeConfig {
  /** Singular noun for log lines: "deal", "ticket". */
  readonly entity: string;
  readonly references: readonly EntityReference[];
  readonly repository: PurgeableRepository;
  readonly retentionDays: number;
  /** Records per pass. Bounded so one run cannot monopolise the primary. */
  readonly batch?: number;
}

const DEFAULT_BATCH = 200;

/**
 * The retention purge, once, for any domain that declares its references.
 *
 * Contacts and accounts each have their own purge service, written before this existed.
 * Adding one for deals, tickets and tasks would have been the third, fourth and fifth copy
 * of the same twenty lines — find expired records, apply each reference's policy, hard
 * delete, keep going past a failure — so the loop lives here and each domain contributes
 * only its registry, its retention window and its cron time.
 *
 * Two invariants this encodes, both learned the hard way:
 *
 *   1. **References first, record last.** If the process dies mid-purge the record is
 *      still soft-deleted and still purgeable, so the next run finishes the job. The
 *      reverse order leaves rows pointing at an id nothing can resolve, with nothing left
 *      to find them by.
 *   2. **A failed cascade keeps the record.** Deleting it while rows still reference it is
 *      the one outcome worse than not purging at all.
 */
@Injectable()
export class RetentionPurgeRunner {
  private readonly logger = new Logger(RetentionPurgeRunner.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  async run(
    config: RetentionPurgeConfig,
  ): Promise<{ purged: number; cascaded: number }> {
    const cutoff = new Date(
      Date.now() - config.retentionDays * 24 * 60 * 60 * 1000,
    );
    const candidates = await config.repository.findPurgeable(
      cutoff,
      config.batch ?? DEFAULT_BATCH,
    );
    if (candidates.length === 0) return { purged: 0, cascaded: 0 };

    let purged = 0;
    let cascaded = 0;

    for (const candidate of candidates) {
      try {
        cascaded += await this.cascade(
          config,
          candidate.id,
          candidate.tenantId,
        );
        await config.repository.hardDelete(candidate.id);
        purged++;
      } catch (err) {
        // One bad record must not stall the queue behind it forever. It stays
        // soft-deleted and purgeable, so the next run retries — logged rather than
        // skipped silently.
        this.logger.error(
          `Failed to purge ${config.entity} ${candidate.id}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { purged, cascaded };
  }

  /** Apply every reference's onPurge policy for one record. */
  private async cascade(
    config: RetentionPurgeConfig,
    entityId: string,
    tenantId: string,
  ): Promise<number> {
    let affected = 0;

    for (const ref of config.references) {
      if (ref.onPurge === 'keep') continue;
      try {
        affected += await this.cascadeOne(ref, entityId, tenantId);
      } catch (err) {
        this.logger.error(
          `Cascade failed for ${ref.collection}.${ref.field} ` +
            `(${config.entity} ${entityId}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        // Rethrow so the caller keeps the record — see invariant 2.
        throw err;
      }
    }

    return affected;
  }

  private async cascadeOne(
    ref: EntityReference,
    entityId: string,
    tenantId: string,
  ): Promise<number> {
    const collection = this.connection.collection(ref.collection);
    const filter = buildReferenceFilter(ref, entityId, tenantId);

    switch (ref.onPurge) {
      case 'cascade': {
        const result = await collection.deleteMany(filter);
        return result.deletedCount ?? 0;
      }

      case 'detach': {
        const result = await collection.updateMany(
          filter,
          buildDetachUpdate(ref),
        );
        return result.modifiedCount ?? 0;
      }

      case 'pull': {
        const pulled = await collection.updateMany(filter, {
          $pull: { [ref.field]: new Types.ObjectId(entityId) } as any,
        });
        // A row left referencing nobody has no owner and no way to be found again.
        await collection.deleteMany({
          tenantId: Types.ObjectId.isValid(tenantId)
            ? new Types.ObjectId(tenantId)
            : tenantId,
          [ref.field]: { $size: 0 },
        });
        return pulled.modifiedCount ?? 0;
      }

      default:
        return 0;
    }
  }
}

/**
 * Retention window from an env var, with the malformed cases rejected.
 *
 * `Number('')` is 0 and `Number('soon')` is NaN, and either taken literally means a cutoff
 * of "now" — every soft-deleted record destroyed on the next run. The fallback is not
 * politeness; it is the difference between a misconfigured deploy and data loss.
 */
export function resolveRetentionDays(
  envVar: string,
  fallbackDays: number,
): number {
  const configured = Number(process.env[envVar]);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : fallbackDays;
}
