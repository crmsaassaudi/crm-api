import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { DealRepository } from './infrastructure/persistence/document/repositories/deal.repository';
import {
  RedisLockService,
  isLockContention,
} from '../redis/redis-lock.service';
import { resolveRetentionDays } from '../common/references/retention-purge.runner';
import {
  buildDetachUpdate,
  buildReferenceFilter,
} from '../common/references/entity-reference';
import { DEAL_REFERENCES } from './deal-references.registry';
import { TransactionManager } from '../database/transaction-manager.service';

/** Days a soft-deleted deal stays restorable. Matches the other domains. */
const DEFAULT_RETENTION_DAYS = 30;

/**
 * The only path that hard-deletes a deal.
 *
 * Completes the recycle bin: without it a soft-deleted deal is restorable for as long as
 * the database exists, which is the accumulation half of what soft delete introduced. The
 * cascade policies live in `deal-references.registry.ts` — read that to find out what happens to a
 * record when its deal is purged.
 *
 * Unlike the shared `RetentionPurgeRunner` (contacts/accounts/tickets/tasks — each
 * cascade step and the final hard-delete run as independent, non-transactional
 * writes, tolerated only because every step is idempotent and the record is
 * deleted last), this service wraps one candidate's ENTIRE cascade + hard-delete
 * in a single Mongo transaction. Deals already require a replica set for
 * ordinary writes — `DealsService.create()`/`update()` run through
 * `AutomationOutboxService.runWithEvent()`, which uses this same
 * `TransactionManager` — so this adds no new infrastructure requirement, only
 * closes the one gap the shared runner leaves open: a crash between "tickets
 * detached" and "deal row removed" used to leave a legitimately-purgeable
 * deal in a partially-cascaded state with no atomic boundary around it.
 */
@Injectable()
export class DealPurgeService {
  private readonly logger = new Logger(DealPurgeService.name);

  constructor(
    private readonly repository: DealRepository,
    private readonly lockService: RedisLockService,
    private readonly transactions: TransactionManager,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  private get retentionDays(): number {
    return resolveRetentionDays(
      'DEAL_PURGE_RETENTION_DAYS',
      DEFAULT_RETENTION_DAYS,
    );
  }

  /**
   * 03:40, after contacts (03:00) and accounts (03:30) and before the 04:00 metrics rollup. Staggered rather than concurrent: these passes `updateMany` overlapping sets of tickets and tasks, and none of the work is urgent enough to contend for the same documents.
   *
   * Cluster-singleton: `@Cron` fires in every process that loaded ScheduleModule, and N
   * replicas racing to purge the same records would each run the cascade.
   */
  @Cron('40 3 * * *')
  async runRetentionPurge(): Promise<void> {
    await this.lockService
      .acquire(
        'cron:deals:retention-purge',
        { ttl: 30 * 60 * 1000, maxRetries: 0 },
        async () => {
          const result = await this.purgeExpired();
          if (result.purged > 0 || result.cascaded > 0) {
            this.logger.log(
              `Deal purge: ${result.purged} deal(s) removed after ` +
                `${this.retentionDays}d retention, ${result.cascaded} related row(s) handled`,
            );
          }
        },
      )
      .catch((err) => {
        // Contention is normal — N replicas tick, one wins. A job that THREW is not, and
        // must not be reported as "skipped" at debug level.
        if (isLockContention(err)) {
          this.logger.debug(
            'Deal purge skipped: another replica holds the lock',
          );
        } else {
          this.logger.error(
            `Deal purge FAILED: ${err instanceof Error ? err.message : String(err)}`,
            err instanceof Error ? err.stack : undefined,
          );
        }
      });
  }

  private static readonly BATCH = 200;

  /** One pass. Exposed so an operator script or a test can drive it. */
  async purgeExpired(): Promise<{ purged: number; cascaded: number }> {
    const cutoff = new Date(
      Date.now() - this.retentionDays * 24 * 60 * 60 * 1000,
    );
    const candidates = await this.repository.findPurgeable(
      cutoff,
      DealPurgeService.BATCH,
    );
    if (candidates.length === 0) return { purged: 0, cascaded: 0 };

    let purged = 0;
    let cascaded = 0;

    for (const candidate of candidates) {
      try {
        // References first, record last — same invariant as the shared
        // runner: a process death mid-purge must leave the deal still
        // soft-deleted and still purgeable, never a dangling reference with
        // nothing left to find it by. The transaction makes "references
        // handled AND record removed" one atomic step instead of two.
        const affected = await this.transactions.runInTransaction(
          async (session) => {
            let count = 0;
            for (const ref of DEAL_REFERENCES) {
              if (ref.onPurge === 'keep') continue;
              const collection = this.connection.collection(ref.collection);
              const filter = buildReferenceFilter(
                ref,
                candidate.id,
                candidate.tenantId,
              );
              if (ref.onPurge === 'cascade') {
                const result = await collection.deleteMany(filter, {
                  session,
                });
                count += result.deletedCount ?? 0;
              } else if (ref.onPurge === 'detach') {
                const result = await collection.updateMany(
                  filter,
                  buildDetachUpdate(ref),
                  { session },
                );
                count += result.modifiedCount ?? 0;
              }
            }
            await this.repository.hardDelete(candidate.id, session);
            return count;
          },
        );
        cascaded += affected;
        purged++;
      } catch (err) {
        // One bad record must not stall the queue behind it forever. It stays
        // soft-deleted and purgeable, so the next run retries — logged rather than
        // skipped silently.
        this.logger.error(
          `Failed to purge deal ${candidate.id}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { purged, cascaded };
  }
}
