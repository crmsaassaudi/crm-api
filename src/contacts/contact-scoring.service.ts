import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ContactRepository } from './infrastructure/persistence/document/repositories/contact.repository';
import {
  RedisLockService,
  isLockContention,
} from '../redis/redis-lock.service';
import { RedisService } from '../redis/redis.service';
import {
  LeadScoringRule,
  LeadScoringService,
} from '../lead-scoring/lead-scoring.service';

/** Contacts rescored per query. */
const PAGE_SIZE = 5_000;

/**
 * Page budget for one nightly run (5M contacts). Caps how long the
 * cluster-singleton lock is held; the resume cursor is stable, so the remainder
 * is simply picked up by the next run rather than skipped.
 */
const MAX_PAGES = 1_000;

/** Where the sweep stopped, so the next night continues instead of restarting. */
const CURSOR_KEY = 'cron:contacts:nightly-scoring:cursor';

@Injectable()
export class ContactScoringService {
  private readonly logger = new Logger(ContactScoringService.name);

  constructor(
    private readonly repository: ContactRepository,
    private readonly lockService: RedisLockService,
    private readonly redis: RedisService,
    private readonly leadScoring: LeadScoringService,
  ) {}

  /**
   * Cluster-singleton: `@Cron` fires in every process that loaded
   * ScheduleModule, so without the lock N replicas run the same all-tenant
   * rescoring pass concurrently against the same documents.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async runNightlyScoreRefresh(): Promise<void> {
    await this.lockService
      .acquire(
        'cron:contacts:nightly-scoring',
        { ttl: 30 * 60 * 1000, maxRetries: 0 },
        async (signal) => {
          const result = await this.scoreAllPages(signal);
          this.logger.log(
            `Contact scoring refreshed: scanned=${result.scanned}, ` +
              `updated=${result.updated}, pages=${result.pages}` +
              (result.exhausted
                ? ''
                : ' (page budget reached — resumes tomorrow)'),
          );
        },
      )
      .catch((err) => {
        // Contention is the normal case — N replicas tick, one wins — but a job that
        // THREW must not be reported as "skipped" at debug level. That conflation is
        // how four nightly jobs stayed dead for as long as they did.
        if (isLockContention(err)) {
          this.logger.debug(
            `Contact scoring skipped: another replica holds the lock`,
          );
        } else {
          this.logger.error(
            `Contact scoring FAILED: ${err instanceof Error ? err.message : String(err)}`,
            err instanceof Error ? err.stack : undefined,
          );
        }
      });
  }

  /**
   * Walk the whole collection page by page.
   *
   * This used to be a single 5,000-document call with no sort and no cursor, so
   * it rescored the same first 5,000 rows every night and never touched the rest:
   * the log said `scanned=5000` and looked healthy while most contacts kept a
   * score of 0 permanently. Paging with a resume cursor is what makes the job do
   * what its name says.
   *
   * Bounded by MAX_PAGES rather than run-to-completion: this holds a
   * cluster-singleton lock, and an unbounded loop on a 100M-row collection would
   * hold it for hours and block every subsequent night's run. Whatever is left
   * over is picked up by the next pass, since the scan order is stable.
   */
  private async scoreAllPages(signal: AbortSignal): Promise<{
    scanned: number;
    updated: number;
    pages: number;
    exhausted: boolean;
  }> {
    // Resume where the last run stopped. Without this the page budget below
    // would not "resume tomorrow" — every run would restart from the first
    // document and the tail of a large collection would never be reached, which
    // is the bug this method exists to fix, just with a bigger first page.
    let cursor = await this.readCursor();
    let scanned = 0;
    let updated = 0;
    let pages = 0;

    for (; pages < MAX_PAGES; pages++) {
      // The lock service aborts the signal if it ever loses ownership; carrying
      // on past that point would mean two replicas writing the same documents.
      if (signal.aborted) break;

      const page = await this.repository.findPageForScoring(PAGE_SIZE, cursor);
      scanned += page.contacts.length;
      updated += await this.scorePage(page.contacts);

      if (!page.nextCursor) {
        // Full sweep complete — clear the cursor so the next run starts over and
        // picks up newly created contacts.
        await this.clearCursor();
        return { scanned, updated, pages: pages + 1, exhausted: true };
      }
      cursor = page.nextCursor;
    }

    // Budget exhausted mid-collection: remember where we stopped.
    if (cursor) await this.writeCursor(cursor);
    return { scanned, updated, pages, exhausted: false };
  }

  /**
   * Score one cross-tenant page with each tenant's own rules.
   *
   * The rule set is loaded once per tenant per page, not per contact: a page is
   * 5,000 documents and most tenants own a contiguous run of them, so this is a
   * handful of rule reads rather than 5,000.
   *
   * A tenant with no active rules is skipped entirely — leaving its scores as
   * they are. Writing 0 would be the sweep inventing a score for a tenant that
   * has not configured one, which is the behaviour this job was changed to stop.
   */
  private async scorePage(
    contacts: Array<Record<string, any>>,
  ): Promise<number> {
    const rulesByTenant = new Map<string, LeadScoringRule[]>();
    const updates: Array<{ id: unknown; tenantId: unknown; score: number }> =
      [];

    for (const contact of contacts) {
      const tenantId = String(contact.tenantId);
      let rules = rulesByTenant.get(tenantId);
      if (rules === undefined) {
        rules = await this.leadScoring.getActiveRules(tenantId);
        rulesByTenant.set(tenantId, rules);
      }
      if (rules.length === 0) continue;

      const score = this.leadScoring.computeScore(rules, contact);
      if (score !== (contact.score ?? 0)) {
        updates.push({ id: contact._id, tenantId: contact.tenantId, score });
      }
    }

    return this.repository.applyScores(updates);
  }

  private async readCursor(): Promise<string | undefined> {
    try {
      return (await this.redis.get<string>(CURSOR_KEY)) ?? undefined;
    } catch {
      // No cursor available → start from the beginning. Costs a repeated pass
      // over the head of the collection, never a skipped tail.
      return undefined;
    }
  }

  private async writeCursor(cursor: string): Promise<void> {
    // TTL is generous but finite: a cursor left behind by a crashed run must
    // eventually expire, or the head of the collection stops being rescored.
    await this.redis.set(CURSOR_KEY, cursor, 7 * 24 * 60 * 60).catch(() => {
      this.logger.warn(
        'Could not persist the scoring cursor; the next run restarts from the beginning.',
      );
    });
  }

  private async clearCursor(): Promise<void> {
    await this.redis.set(CURSOR_KEY, '', 1).catch(() => undefined);
  }
}
