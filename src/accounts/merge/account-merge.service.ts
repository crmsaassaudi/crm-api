import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AccountRepository } from '../infrastructure/persistence/document/repositories/account.repository';
import { Account } from '../domain/account';
import { RedisLockService } from '../../redis/redis-lock.service';
import { EntityAuditService } from '../../common/audit/entity-audit.service';
import { deriveCompanyIdentity } from '../../common/identity/company-identity';
import {
  ACCOUNT_ACTIVITY_TARGET_TYPE,
  ACCOUNT_MERGE_REFERENCES,
  AccountReference,
  buildAccountReferenceFilter,
  buildAccountReparentUpdate,
} from './account-references.registry';

/** Fields filled from the loser when the survivor has none. */
const FILL_FIELDS = [
  'website',
  'industry',
  'typeId',
  'taxId',
  'annualRevenue',
  'numberOfEmployees',
  'billingAddress',
  'shippingAddress',
  'ownerId',
  'orgUnitId',
  'statusId',
] as const;

export interface AccountMergePreview {
  survivor: { id: string; name: string };
  merged: { id: string; name: string };
  fieldChoices: Record<
    string,
    { chosen: unknown; from: 'survivor' | 'merged'; discarded?: unknown }
  >;
  willReparent: Record<string, number>;
}

export interface AccountMergeResult {
  success: true;
  account: Account;
  mergedAccountId: string;
  reparented: Record<string, number>;
  /** Per-field outcome, so the caller can show what the merge discarded. */
  fieldChoices: AccountMergePreview['fieldChoices'];
}

/**
 * Merging two account records that turned out to be the same organisation.
 *
 * The sequel to company-identity dedup: detection tells you two accounts are the same
 * company, this is what you do about it. Built on the same principles the contact merge
 * arrived at the hard way — because the original contact merge unioned a few fields,
 * archived the loser, and re-parented nothing, leaving every deal, ticket and contact
 * pointing at a record the UI no longer showed. Unreachable rather than deleted, and
 * nothing errored.
 *
 * So: re-parent every reference in the registry BEFORE archiving the loser. If the
 * process dies mid-merge the failure mode is "some rows already moved and both accounts
 * are still visible" — confusing but repairable by rerunning. The reverse order fails to
 * "rows point at an invisible account", which is the bug being avoided.
 *
 * Deliberately simpler than ContactMergeService in one respect: no ledger, no unmerge.
 * Contacts needed those because a contact merge discards per-identity consent and
 * conversation history that cannot be reconstructed. An account merge moves whole
 * records and fills blanks; the loser is soft-deleted and restorable, and the audit trail
 * records the field diff. Adding an unreachable unmerge path would be scaffolding for a
 * need that has not appeared.
 */
@Injectable()
export class AccountMergeService {
  private readonly logger = new Logger(AccountMergeService.name);

  constructor(
    private readonly repository: AccountRepository,
    private readonly lockService: RedisLockService,
    private readonly entityAudit: EntityAuditService,
    private readonly cls: ClsService,
    private readonly eventEmitter: EventEmitter2,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /** What a merge would do. Writes nothing. */
  async preview(
    survivorId: string,
    mergedId: string,
  ): Promise<AccountMergePreview> {
    const { survivor, merged } = await this.loadPair(survivorId, mergedId);
    const { choices } = this.resolveSurvivorship(survivor, merged);

    const willReparent: Record<string, number> = {};
    for (const ref of ACCOUNT_MERGE_REFERENCES) {
      const count = await this.countReferences(ref, mergedId);
      if (count > 0) {
        // Summed by label: `contacts` and `account_contact_relations` are two rows in
        // the registry but one idea to a user looking at the dialog.
        willReparent[ref.label] = (willReparent[ref.label] ?? 0) + count;
      }
    }

    return {
      survivor: { id: survivor.id, name: survivor.name },
      merged: { id: merged.id, name: merged.name },
      fieldChoices: choices,
      willReparent,
    };
  }

  async merge(
    survivorId: string,
    mergedId: string,
  ): Promise<AccountMergeResult> {
    if (survivorId === mergedId) {
      throw new BadRequestException('Cannot merge an account into itself');
    }

    // Sorted key: the same pair maps to one lock regardless of which side the caller
    // nominated as survivor, so two people merging A→B and B→A serialise rather than
    // deadlock.
    const [a, b] = [survivorId, mergedId].sort((x, y) => x.localeCompare(y));
    return this.lockService.acquire(
      `lock:account:merge:${a}:${b}`,
      30_000,
      () => this.executeMerge(survivorId, mergedId),
    );
  }

  private async executeMerge(
    survivorId: string,
    mergedId: string,
  ): Promise<AccountMergeResult> {
    const { survivor, merged } = await this.loadPair(survivorId, mergedId);
    const { update, choices } = this.resolveSurvivorship(survivor, merged);
    const occurredAt = new Date();

    // 1. Move everything that points at the loser (see the class comment on ordering).
    const reparented = await this.reparentAll(survivorId, mergedId);

    // 2. Apply survivorship, with a version check — the lock serialises merges of this
    //    pair but not an ordinary PATCH by someone who had the account open.
    const updated = await this.repository.updateWithVersionCheck(
      survivorId,
      survivor.version ?? 0,
      update as any,
    );
    if (!updated) {
      throw new ConflictException(
        'The surviving account was modified while the merge was running. Reload and ' +
          'try again — related records already moved and will not be moved twice.',
      );
    }

    // 3. Soft-delete the loser. Never a hard delete: the audit trail references its id,
    //    and a mis-merge should be recoverable from the recycle bin.
    await this.repository.remove(mergedId);

    this.entityAudit.emit({
      entity: 'account',
      entityType: 'ACCOUNT',
      entityId: survivorId,
      kind: 'updated',
      oldSnapshot: survivor,
      newSnapshot: updated,
    });

    this.eventEmitter.emit('activity.create', {
      tenantId: this.tenantId(),
      actorId: this.userId(),
      targetType: ACCOUNT_ACTIVITY_TARGET_TYPE,
      targetId: survivorId,
      event: 'merge',
      occurredAt,
      payload: {
        mergedAccountId: mergedId,
        mergedName: merged.name,
        reparented,
        // The discarded values live here and nowhere else a reader can reach: the
        // audit diff shows what the survivor gained, not what the loser had and lost.
        // Without this, "why is the website still the old one?" has no answer short of
        // restoring the archived account.
        fieldChoices: choices,
      },
    });

    this.logger.log(
      `Merged account ${mergedId} into ${survivorId}: ` +
        (Object.entries(reparented)
          .map(([k, v]) => `${v} ${k}`)
          .join(', ') || 'no related records'),
    );

    return {
      success: true,
      account: updated,
      mergedAccountId: mergedId,
      reparented,
      fieldChoices: choices,
    };
  }

  /**
   * Fill the survivor's blanks from the loser. Never overwrite a value the survivor
   * already has — "fill the blanks" is what people expect from a merge and is the only
   * rule that cannot silently destroy data. Every decision is reported so the preview
   * can show what would be discarded.
   */
  private resolveSurvivorship(
    survivor: Account,
    merged: Account,
  ): {
    update: Record<string, unknown>;
    choices: AccountMergePreview['fieldChoices'];
  } {
    const update: Record<string, unknown> = {};
    const choices: AccountMergePreview['fieldChoices'] = {};

    for (const field of FILL_FIELDS) {
      const mine = (survivor as any)[field];
      const theirs = (merged as any)[field];

      if (isBlank(mine) && !isBlank(theirs)) {
        update[field] = theirs;
        choices[field] = { chosen: theirs, from: 'merged' };
      } else if (!isBlank(mine)) {
        choices[field] = {
          chosen: mine,
          from: 'survivor',
          ...(isBlank(theirs) || theirs === mine ? {} : { discarded: theirs }),
        };
      }
    }

    // Reachability is additive: never lose a way to contact the company.
    for (const field of ['emails', 'phones', 'tags'] as const) {
      const union = Array.from(
        new Set([
          ...(((survivor as any)[field] as unknown[]) ?? []),
          ...(((merged as any)[field] as unknown[]) ?? []),
        ]).values(),
      ).filter((v) => v !== null && v !== '');
      update[field] = union;
      choices[field] = { chosen: union, from: 'survivor' };
    }

    // customFields: fill per key, same rule one level down.
    const customFields = { ...(merged.customFields ?? {}) };
    for (const [key, value] of Object.entries(survivor.customFields ?? {})) {
      if (!isBlank(value)) customFields[key] = value;
    }
    if (Object.keys(customFields).length > 0) {
      update.customFields = customFields;
    }

    // Re-derive the comparison keys whenever survivorship changed a field they come
    // from. A merge is precisely when this matters: the survivor typically has no
    // website or tax id — that is often WHY it was the weaker duplicate — and inherits
    // one here. Without this the account gains `website: acme.com` and keeps an empty
    // `websiteDomain`, so it is immediately un-findable as a duplicate of the next
    // record with that domain, right after a human confirmed the domain identifies it.
    if (update.website !== undefined || update.taxId !== undefined) {
      const identity = deriveCompanyIdentity({
        name: (update.name as string) ?? survivor.name,
        website: (update.website as string) ?? survivor.website,
        taxId: (update.taxId as string) ?? survivor.taxId,
      });
      update.nameKey = identity.nameKey;
      update.websiteDomain = identity.domain;
      update.taxIdKey = identity.taxIdKey;
    }

    return { update, choices };
  }

  private async reparentAll(
    survivorId: string,
    mergedId: string,
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const ref of ACCOUNT_MERGE_REFERENCES) {
      const moved = await this.reparentOne(ref, mergedId, survivorId);
      if (moved > 0) counts[ref.collection] = moved;
    }
    return counts;
  }

  private async reparentOne(
    ref: AccountReference,
    fromId: string,
    toId: string,
  ): Promise<number> {
    const collection = this.connection.collection(ref.collection);
    const filter = buildAccountReferenceFilter(ref, fromId, this.tenantId());

    try {
      // Paired rows must have collisions cleared first or the unique index aborts the
      // whole updateMany rather than skipping the one offending row.
      if (ref.pairedWith) {
        await this.resolvePairConflicts(ref, fromId, toId);
      }

      const result = await collection.updateMany(
        filter,
        buildAccountReparentUpdate(ref, toId) as any,
      );
      return result.matchedCount;
    } catch (err) {
      // One collection failing must not abandon the merge with no record of it: log
      // loudly, continue, and let the returned counts show what actually moved.
      this.logger.error(
        `Failed to re-parent ${ref.collection}.${ref.field} from ${fromId} to ${toId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Soft-delete the loser's paired rows that cannot survive re-parenting — where the
   * survivor already holds the equivalent fact. Soft, not removed, so the loser stays
   * restorable as a whole.
   */
  private async resolvePairConflicts(
    ref: AccountReference,
    fromId: string,
    toId: string,
  ): Promise<void> {
    const paired = ref.pairedWith!;
    const collection = this.connection.collection(ref.collection);
    const tenantId = new Types.ObjectId(this.tenantId());
    const now = new Date();

    const losers = await collection
      .find(
        { tenantId, [ref.field]: new Types.ObjectId(fromId), deletedAt: null },
        {
          projection: Object.fromEntries(
            [paired.otherField, ...paired.discriminantFields].map((f) => [
              f,
              1,
            ]),
          ),
        },
      )
      .limit(500)
      .toArray();

    for (const loser of losers) {
      const twin = await collection.findOne({
        tenantId,
        [ref.field]: new Types.ObjectId(toId),
        [paired.otherField]: (loser as any)[paired.otherField],
        ...Object.fromEntries(
          paired.discriminantFields.map((f) => [f, (loser as any)[f]]),
        ),
        deletedAt: null,
      });
      if (twin) {
        await collection.updateOne(
          { _id: (loser as any)._id },
          { $set: { deletedAt: now } },
        );
      }
    }
  }

  private async countReferences(
    ref: AccountReference,
    accountId: string,
  ): Promise<number> {
    try {
      return await this.connection
        .collection(ref.collection)
        .countDocuments(
          buildAccountReferenceFilter(ref, accountId, this.tenantId()),
          { limit: 10_000 },
        );
    } catch {
      return 0;
    }
  }

  private async loadPair(
    survivorId: string,
    mergedId: string,
  ): Promise<{ survivor: Account; merged: Account }> {
    // Through the repository, so tenant and visibility scoping apply: merge must never
    // be a way to reach an account you cannot otherwise see.
    const [survivor, merged] = await Promise.all([
      this.repository.findOne({ _id: survivorId }),
      this.repository.findOne({ _id: mergedId }),
    ]);

    if (!survivor) throw new NotFoundException('Primary account not found');
    if (!merged) throw new NotFoundException('Target account not found');
    return { survivor, merged };
  }

  private tenantId(): string {
    return this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
  }

  private userId(): string | undefined {
    return this.cls.get('userId') ?? this.cls.get('user.id');
  }
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
