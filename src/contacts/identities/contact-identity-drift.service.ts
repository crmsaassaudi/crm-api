import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ContactSchemaClass } from '../infrastructure/persistence/document/entities/contact.schema';
import {
  RedisLockService,
  isLockContention,
} from '../../redis/redis-lock.service';
import {
  normalizeEmail,
  normalizePhone,
} from '../../common/identity/identity-normalizer';
import {
  ContactIdentityDocument,
  ContactIdentitySchemaClass,
} from './contact-identity.schema';

/** Contacts sampled per run. A health check, not an exhaustive audit — see the cron. */
const SAMPLE_SIZE = 2_000;

export interface DriftReport {
  scanned: number;
  /** In the arrays, absent from `contact_identities`. */
  missing: number;
  /** In `contact_identities`, absent from the arrays. */
  orphaned: number;
  /** Up to a handful of `contactId → key` examples, for the log line. */
  samples: string[];
}

/**
 * Watches whether `contact_identities` still agrees with the authoritative
 * `emails[]` / `phones[]` / `omniIdentities[]` arrays.
 *
 * `ContactIdentitySyncService` is non-throwing by design: the arrays are already saved
 * by the time it runs, so failing a contact write for a projection's sake would be
 * worse than letting the projection lag. That makes drift a **normal operating
 * condition** rather than an impossible one — and therefore something that has to be
 * watched rather than assumed.
 *
 * `scripts/check-contact-identity-drift.ts` does the same comparison exhaustively for an
 * operator. This exists because a check nobody runs is a check that does not exist: the
 * script answers "is it healthy right now", this answers "would we notice if it stopped
 * being".
 *
 * Why drift matters concretely:
 *   - a missing row means the partial unique index is not protecting that value, so a
 *     second contact can be created holding the same email;
 *   - it also means the omni resolver's identity lookup cannot find that contact, so an
 *     inbound message may create a duplicate shadow contact for someone already known.
 *
 * Reports only. Repair is `backfill:contact-identities`, deliberately kept as an
 * operator action: silently rewriting identity rows on a schedule would mask whatever is
 * breaking the sync, which is the thing actually worth knowing.
 */
@Injectable()
export class ContactIdentityDriftService {
  private readonly logger = new Logger(ContactIdentityDriftService.name);

  constructor(
    @InjectModel(ContactSchemaClass.name)
    private readonly contactModel: Model<any>,
    @InjectModel(ContactIdentitySchemaClass.name)
    private readonly identityModel: Model<ContactIdentityDocument>,
    private readonly lockService: RedisLockService,
  ) {}

  /**
   * Cluster-singleton, like the other crons: `@Cron` fires in every process that loaded
   * ScheduleModule, and N replicas would each run the same scan.
   *
   * 05:00 — after the 03:00 purge and the 04:00 rollup, so it observes a settled state
   * rather than racing the jobs that mutate what it is measuring.
   */
  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async runDriftCheck(): Promise<void> {
    await this.lockService
      .acquire(
        'cron:contacts:identity-drift',
        { ttl: 15 * 60 * 1000, maxRetries: 0 },
        async () => {
          const report = await this.sample();
          this.report(report);
        },
      )
      .catch((err) => {
        // Contention is the normal case — N replicas tick, one wins — but a job that
        // THREW must not be reported as "skipped" at debug level. That conflation is
        // how four nightly jobs stayed dead for as long as they did.
        if (isLockContention(err)) {
          this.logger.debug(
            `Contact identity drift check skipped: another replica holds the lock`,
          );
        } else {
          this.logger.error(
            `Contact identity drift check FAILED: ${err instanceof Error ? err.message : String(err)}`,
            err instanceof Error ? err.stack : undefined,
          );
        }
      });
  }

  /**
   * Compare a sample of contacts against their identity rows.
   *
   * Sampled rather than exhaustive: this runs every day on every tenant's data, and a
   * full scan would cost more than the problem. Drift from a broken sync shows up in any
   * sample; drift in one unlucky document is what the exhaustive script is for.
   *
   * Newest-first, because a sync that has started failing fails on recent writes — the
   * old rows were written when it worked.
   */
  async sample(limit = SAMPLE_SIZE): Promise<DriftReport> {
    const contacts = await this.contactModel
      .find({ deletedAt: null })
      // Cross-tenant: drift is a platform health question, and the 05:00 cron has no
      // request context. Unmarked, the plugin throws and the check reports nothing —
      // the same silence it was built to break.
      .setOptions({ isPlatformQuery: true } as any)
      .select({ emails: 1, phones: 1, omniIdentities: 1 })
      .sort({ _id: -1 })
      .limit(limit)
      .lean()
      .read('secondaryPreferred')
      .exec();

    if (contacts.length === 0) {
      return { scanned: 0, missing: 0, orphaned: 0, samples: [] };
    }

    const ids = contacts.map((c: any) => c._id);
    const rows = await this.identityModel
      .find({ contactId: { $in: ids }, deletedAt: null })
      .setOptions({ isPlatformQuery: true } as any)
      .select({ contactId: 1, type: 1, normalisedValue: 1 })
      .lean()
      .read('secondaryPreferred')
      .exec();

    // One pass to group, so the comparison below is O(contacts) rather than a query
    // per contact — the shape the operator script can afford and a daily cron cannot.
    const byContact = new Map<string, Set<string>>();
    for (const row of rows as any[]) {
      const key = String(row.contactId);
      if (!byContact.has(key)) byContact.set(key, new Set());
      byContact.get(key)!.add(`${row.type}:${row.normalisedValue}`);
    }

    let missing = 0;
    let orphaned = 0;
    const samples: string[] = [];

    for (const contact of contacts as any[]) {
      const id = String(contact._id);
      const expected = this.expectedKeys(contact);
      const actual = byContact.get(id) ?? new Set<string>();

      for (const key of expected) {
        if (!actual.has(key)) {
          missing++;
          if (samples.length < 5) samples.push(`missing ${id} ${key}`);
        }
      }
      for (const key of actual) {
        if (!expected.has(key)) {
          orphaned++;
          if (samples.length < 5) samples.push(`orphaned ${id} ${key}`);
        }
      }
    }

    return { scanned: contacts.length, missing, orphaned, samples };
  }

  /**
   * The identity keys a contact document implies.
   *
   * Uses the shared normaliser, so this cannot disagree with what the sync writes — a
   * drift checker with its own idea of normalisation reports differences that are its
   * own, and a checker that cries wolf gets ignored.
   *
   * No country code is available here (there is no tenant context in a cron), so
   * national-format phones are compared as typed. The sync had the same information
   * when it wrote them, so the two agree; only a tenant that changed its dialling code
   * between the two would show a difference, and the operator script takes
   * `--countryCode` for exactly that case.
   */
  private expectedKeys(contact: {
    emails?: unknown[];
    phones?: unknown[];
    omniIdentities?: Array<{ channelType?: string; senderId?: string }>;
  }): Set<string> {
    const keys = new Set<string>();

    for (const raw of contact.emails ?? []) {
      if (typeof raw !== 'string') continue;
      const value = normalizeEmail(raw);
      if (value) keys.add(`email:${value}`);
    }
    for (const raw of contact.phones ?? []) {
      if (typeof raw !== 'string') continue;
      const value = normalizePhone(raw);
      if (value) keys.add(`phone:${value}`);
    }
    for (const identity of contact.omniIdentities ?? []) {
      if (!identity?.channelType || !identity?.senderId) continue;
      keys.add(
        `omni:${identity.channelType.toLowerCase()}:${identity.senderId}`,
      );
    }

    return keys;
  }

  /**
   * Log at a level that matches the severity, so this is alertable.
   *
   * `warn` rather than `log` when drift exists: a line that says "0 drift" every day and
   * changes to "17 drift" in the same log level is a line nobody reads.
   */
  private report(report: DriftReport): void {
    const total = report.missing + report.orphaned;

    if (total === 0) {
      this.logger.log(
        `Contact identity projection healthy: ${report.scanned} sampled, no drift`,
      );
      return;
    }

    this.logger.warn(
      `Contact identity DRIFT: ${report.missing} missing, ${report.orphaned} orphaned ` +
        `across ${report.scanned} sampled contacts. ` +
        `Examples: ${report.samples.join('; ')}. ` +
        'A missing row means the unique index is not protecting that value and the omni ' +
        'resolver cannot find that contact by it. Repair with ' +
        '`npm run backfill:contact-identities` after checking why the sync is failing.',
    );
  }
}
