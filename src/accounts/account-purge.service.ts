import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AccountRepository } from './infrastructure/persistence/document/repositories/account.repository';
import {
  RedisLockService,
  isLockContention,
} from '../redis/redis-lock.service';
import { RetentionPurgeRunner } from '../common/references/retention-purge.runner';
import { ACCOUNT_REFERENCES } from './merge/account-references.registry';

/** Days a soft-deleted account stays restorable. Matches the contact window. */
const DEFAULT_RETENTION_DAYS = 30;

/** Accounts purged per run — bounded so one pass cannot monopolise the primary. */
const PURGE_BATCH = 200;

/**
 * AccountPurgeService — the ONLY place an account is hard-deleted.
 *
 * The other half of the recycle bin. Without it, a soft-deleted account is restorable
 * for exactly as long as the database exists: the row never leaves, which is the
 * accumulation half of the problem soft delete introduced. And a GDPR erasure request
 * against a company record could not be honoured, because the row survives the deletion
 * that was supposed to remove it.
 *
 * It also makes `onPurge` real. The account reference registry has declared a policy per
 * collection since it was written, and until now nothing read it — the column was
 * documentation that looked like behaviour. The policies matter because they are NOT
 * uniform:
 *
 *   detach  — contacts, deals, tickets. A company record being purged must not take its
 *             revenue, its support history, or the people who work there with it. The
 *             pointer is nulled; the record survives.
 *   cascade — affiliation rows and the account's own timeline. An affiliation has no
 *             meaning without the company end of it, and a timeline entry describes
 *             nothing once its subject is gone.
 *   keep    — the audit trail. Compliance evidence outlives the record it describes.
 *
 * Deliberately a separate service from ContactPurgeService rather than a shared base.
 * The two cascades differ in kind: contacts have `pull` semantics for many-to-many
 * arrays and a `relatedTo` sub-document to unset, neither of which an account has. A
 * shared abstraction would carry both sets of cases so each domain could ignore half of
 * them — and the question these services exist to answer ("what happens to a deal when
 * its account is purged?") would move one level of indirection away from the answer.
 *
 * Ordering: references first, account last. If the process dies mid-purge the account is
 * still soft-deleted and still purgeable, so the next run finishes the job. Deleting the
 * account first would leave rows pointing at an id nothing can resolve — the exact
 * failure this service exists to prevent.
 */
@Injectable()
export class AccountPurgeService {
  private readonly logger = new Logger(AccountPurgeService.name);

  constructor(
    private readonly repository: AccountRepository,
    private readonly lockService: RedisLockService,
    private readonly runner: RetentionPurgeRunner,
  ) {}

  private get retentionDays(): number {
    const configured = Number(process.env.ACCOUNT_PURGE_RETENTION_DAYS);
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_RETENTION_DAYS;
  }

  /**
   * 03:30, after the contact purge at 03:00.
   *
   * Deliberately not the same minute: purging a contact detaches it from tickets and
   * deals, and purging an account detaches those same rows. Running them concurrently
   * means two passes issuing `updateMany` against the same documents for no benefit —
   * the work is not urgent enough to overlap.
   *
   * Cluster-singleton, like every other cron here: `@Cron` fires in every process that
   * loaded ScheduleModule, and N replicas racing to purge the same accounts would each
   * run the cascade.
   */
  @Cron('30 3 * * *')
  async runRetentionPurge(): Promise<void> {
    await this.lockService
      .acquire(
        'cron:accounts:retention-purge',
        { ttl: 30 * 60 * 1000, maxRetries: 0 },
        async () => {
          const result = await this.purgeExpired();
          if (result.purged > 0 || result.cascaded > 0) {
            this.logger.log(
              `Account purge: ${result.purged} account(s) removed after ` +
                `${this.retentionDays}d retention, ${result.cascaded} related row(s) handled`,
            );
          }
        },
      )
      .catch((err) => {
        // Contention is the normal case — N replicas tick, one wins — but a job that
        // THREW must not be reported as "skipped" at debug level. That conflation is
        // how four nightly jobs stayed dead for as long as they did.
        if (isLockContention(err)) {
          this.logger.debug(
            'Account purge skipped: another replica holds the lock',
          );
        } else {
          this.logger.error(
            `Account purge FAILED: ${err instanceof Error ? err.message : String(err)}`,
            err instanceof Error ? err.stack : undefined,
          );
        }
      });
  }

  /**
   * One pass over everything past the retention window.
   *
   * The loop itself is `RetentionPurgeRunner`: this service used to carry its own copy,
   * complete with the two invariants every purge depends on — references first and record
   * last, and a failed cascade KEEPS the record. Three copies of those meant a future fix
   * had to be applied three times to be true.
   *
   * Exposed (not private) so an operator script or a test can drive one pass.
   */
  async purgeExpired(): Promise<{ purged: number; cascaded: number }> {
    return this.runner.run({
      entity: 'account',
      references: ACCOUNT_REFERENCES,
      repository: this.repository,
      retentionDays: this.retentionDays,
      batch: PURGE_BATCH,
    });
  }
}
