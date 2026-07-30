import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ContactRepository } from './infrastructure/persistence/document/repositories/contact.repository';
import {
  RedisLockService,
  isLockContention,
} from '../redis/redis-lock.service';
import { RetentionPurgeRunner } from '../common/references/retention-purge.runner';
import { CONTACT_REFERENCES } from './contact-references.registry';

/** Days a soft-deleted contact stays restorable. Salesforce uses 15, HubSpot 90. */
const DEFAULT_RETENTION_DAYS = 30;

/** Contacts purged per run — bounded so one pass cannot monopolise the primary. */
const PURGE_BATCH = 200;

/**
 * ContactPurgeService — the ONLY place a contact is hard-deleted.
 *
 * `DELETE /contacts/:id` used to call the base repository's `deleteOne`, which
 * destroyed the document immediately. That left every referencing row —
 * notes, tickets, deals, tasks, conversations, email bodies, timeline entries —
 * pointing at an id that no longer resolved, with no recycle bin and no way to
 * repair the damage. It also meant a GDPR erasure request could not be honoured
 * correctly, because the references holding the subject's data survived the
 * record that identified them.
 *
 * Delete is now a soft delete. This job completes it after the retention window
 * and cascades according to each reference's declared `onPurge` policy:
 *
 *   cascade — the row only exists to describe this contact (notes, timeline).
 *   detach  — the row has standalone operational value; null the pointer
 *             (tickets keep their SLA history, tasks keep their assignment).
 *   pull    — the row references several contacts; drop this one, and delete the
 *             row only when it becomes unreferenced (deals, email bodies).
 *   keep    — compliance evidence outlives the subject (audit trail).
 *
 * Ordering: references first, contact last. If the process dies mid-purge the
 * contact is still soft-deleted and still purgeable, so the next run finishes
 * the job. Deleting the contact first would leave orphans with nothing left to
 * find them by — the exact failure this service exists to prevent.
 */
@Injectable()
export class ContactPurgeService {
  private readonly logger = new Logger(ContactPurgeService.name);

  constructor(
    private readonly repository: ContactRepository,
    private readonly lockService: RedisLockService,
    private readonly runner: RetentionPurgeRunner,
  ) {}

  private get retentionDays(): number {
    const configured = Number(process.env.CONTACT_PURGE_RETENTION_DAYS);
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_RETENTION_DAYS;
  }

  /**
   * Cluster-singleton, like the scoring cron: `@Cron` fires in every process
   * that loaded ScheduleModule, and N replicas racing to purge the same contacts
   * would each run the cascade.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runRetentionPurge(): Promise<void> {
    await this.lockService
      .acquire(
        'cron:contacts:retention-purge',
        { ttl: 30 * 60 * 1000, maxRetries: 0 },
        async () => {
          const result = await this.purgeExpired();
          if (result.purged > 0 || result.cascaded > 0) {
            this.logger.log(
              `Contact purge: ${result.purged} contact(s) removed after ` +
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
            `Contact purge skipped: another replica holds the lock`,
          );
        } else {
          this.logger.error(
            `Contact purge FAILED: ${err instanceof Error ? err.message : String(err)}`,
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
   * Contacts are the reason the runner supports `pull` and `relatedTo` at all —
   * those cases were written here first and generalised outward, so the shared
   * implementation is this one, moved.
   *
   * Exposed (not private) so an operator script or a test can drive one pass.
   */
  async purgeExpired(): Promise<{ purged: number; cascaded: number }> {
    return this.runner.run({
      entity: 'contact',
      references: CONTACT_REFERENCES,
      repository: this.repository,
      retentionDays: this.retentionDays,
      batch: PURGE_BATCH,
    });
  }
}
