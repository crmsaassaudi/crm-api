import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redis from 'ioredis';

import { ContactRepository } from '../infrastructure/persistence/document/repositories/contact.repository';
import { Contact } from '../domain/contact';
import { RedisLockService } from '../../redis/redis-lock.service';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { EntityAuditService } from '../../common/audit/entity-audit.service';
import {
  ContactMergeSchemaClass,
  ContactMergeDocument,
} from './contact-merge.schema';
import {
  CONTACT_REFERENCES,
  MERGE_REFERENCES,
  ContactReference,
  buildReferenceFilter,
  buildReparentUpdate,
} from '../contact-references.registry';
import {
  resolveSurvivorship,
  FieldChoice,
  SurvivorshipOptions,
} from './contact-survivorship';

export interface MergePreview {
  survivor: { id: string; name: string };
  merged: { id: string; name: string };
  /** Per-field outcome, so the UI can render a side-by-side picker. */
  fieldChoices: Record<string, FieldChoice>;
  /** `{ label: rowCount }` — what will be moved onto the survivor. */
  willReparent: Record<string, number>;
}

export interface MergeResult {
  success: true;
  contact: Contact;
  mergedContactId: string;
  mergeId: string;
  reparented: Record<string, number>;
  fieldChoices: Record<string, FieldChoice>;
}

/**
 * ContactMergeService — merge as a domain operation rather than a field copy.
 *
 * The previous implementation, inline in ContactsService, unioned emails,
 * phones, omniIdentities and stageHistory, then soft-deleted the loser. It never
 * touched a single related record, so notes, tickets, deals, tasks,
 * conversations, email bodies and the activity feed kept pointing at a contact
 * the UI no longer shows. Nothing errored; the data simply became unreachable.
 * It also discarded the loser's scalar fields with no record of what was lost,
 * and left the omni identity cache (24h TTL) resolving inbound messages to the
 * archived contact.
 *
 * This version:
 *   1. holds the same sorted-pair Redis lock (deadlock-free by construction);
 *   2. resolves survivorship explicitly and reports every decision;
 *   3. re-parents every reference in CONTACT_REFERENCES;
 *   4. writes a ledger row that makes the merge explainable and reversible;
 *   5. invalidates the omni identity cache for the loser's identities.
 *
 * Ordering matters and is deliberate: re-parent BEFORE soft-deleting the loser.
 * If the process dies mid-merge, the failure mode is "some rows already point at
 * the survivor and both contacts are still visible" — confusing but repairable
 * by rerunning. The reverse order fails to "rows point at an invisible contact",
 * which is the bug being fixed.
 */
@Injectable()
export class ContactMergeService {
  private readonly logger = new Logger(ContactMergeService.name);

  constructor(
    private readonly repository: ContactRepository,
    private readonly lockService: RedisLockService,
    private readonly entityAudit: EntityAuditService,
    private readonly cls: ClsService,
    private readonly eventEmitter: EventEmitter2,
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(ContactMergeSchemaClass.name)
    private readonly mergeModel: Model<ContactMergeDocument>,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Non-destructive preview: exactly what `merge` would do, computed with the
   * same code. Feeds the merge dialog so a user can see the field outcomes and
   * the related-record counts before committing.
   */
  async preview(
    survivorId: string,
    mergedId: string,
    options: SurvivorshipOptions = {},
  ): Promise<MergePreview> {
    const { survivor, merged } = await this.loadPair(survivorId, mergedId);
    const { choices } = resolveSurvivorship(survivor, merged, options);

    const willReparent: Record<string, number> = {};
    for (const ref of MERGE_REFERENCES) {
      const count = await this.countReferences(ref, mergedId);
      if (count > 0) willReparent[ref.label] = count;
    }

    return {
      survivor: { id: survivor.id, name: displayName(survivor) },
      merged: { id: merged.id, name: displayName(merged) },
      fieldChoices: choices,
      willReparent,
    };
  }

  async merge(
    survivorId: string,
    mergedId: string,
    options: SurvivorshipOptions = {},
  ): Promise<MergeResult> {
    if (survivorId === mergedId) {
      throw new BadRequestException('Cannot merge a contact into itself');
    }

    // Sorted lock key: the same pair always maps to the same key regardless of
    // which side the caller nominated as survivor, so two agents merging A→B and
    // B→A serialise instead of deadlocking.
    const [a, b] = [survivorId, mergedId].sort((x, y) => x.localeCompare(y));
    return this.lockService.acquire(
      `lock:contact:merge:${a}:${b}`,
      30_000,
      () => this.executeMerge(survivorId, mergedId, options),
    );
  }

  private async executeMerge(
    survivorId: string,
    mergedId: string,
    options: SurvivorshipOptions,
  ): Promise<MergeResult> {
    const { survivor, merged } = await this.loadPair(survivorId, mergedId);

    // Guard against merging a chain: if the loser is itself the survivor of an
    // un-reverted merge, merging it away again strands that merge's ledger.
    const inboundMerge = await this.mergeModel
      .findOne({ survivorId: mergedId, revertedAt: null })
      .lean()
      .exec();
    if (inboundMerge) {
      this.logger.warn(
        `Contact ${mergedId} is the survivor of merge ${String(inboundMerge._id)} — ` +
          'merging it away will chain the ledger.',
      );
    }

    const { update, choices } = resolveSurvivorship(survivor, merged, options);
    const occurredAt = new Date();

    // ── 1. Re-parent first (see the class comment on ordering) ──
    const reparented = await this.reparentAll(survivorId, mergedId);

    // ── 2. Apply survivorship to the survivor, with a version check ──
    // The lock serialises merges of this pair but NOT an ordinary PATCH by an
    // agent who had the contact open. Without the check that edit is silently
    // overwritten by our pre-merge snapshot.
    const updated = await this.repository.updateWithVersionCheck(
      survivorId,
      survivor.version ?? 0,
      { ...update, lastActivityAt: occurredAt } as any,
    );
    if (!updated) {
      throw new ConflictException(
        'The surviving contact was modified while the merge was running. ' +
          'Reload and try again — related records already moved and will not be moved twice.',
      );
    }

    // ── 3. Soft-delete the loser (never a hard delete: unmerge needs it) ──
    await this.repository.update(mergedId, {
      deletedAt: occurredAt,
      lastActivityAt: occurredAt,
    } as any);

    // ── 4. Ledger ──
    const ledger = await this.mergeModel.create({
      tenantId: this.tenantId(),
      survivorId,
      mergedId,
      performedById: this.userId(),
      fieldChoices: choices,
      reparented,
      mergedSnapshot: stripVolatile(merged),
    });

    // ── 5. Invalidate the omni identity cache ──
    // The cache maps a channel thread → contactId with a 24h TTL. Left alone,
    // inbound messages keep resolving to the contact that no longer exists.
    await this.invalidateOmniIdentityCache(merged);

    // ── 6. Audit + activity ──
    this.entityAudit.emit({
      entity: 'contact',
      entityType: 'CONTACT',
      entityId: survivorId,
      kind: 'updated',
      oldSnapshot: survivor,
      newSnapshot: updated,
    });
    this.eventEmitter.emit('activity.create', {
      tenantId: this.tenantId(),
      actorId: this.userId(),
      targetType: 'contact',
      targetId: survivorId,
      event: 'merge',
      occurredAt,
      payload: {
        mergedContactId: mergedId,
        mergeId: String(ledger._id),
        reparented,
        emailsAdded: merged.emails ?? [],
        phonesAdded: merged.phones ?? [],
      },
    });

    this.logger.log(
      `Merged contact ${mergedId} into ${survivorId}: ` +
        `${
          Object.entries(reparented)
            .map(([k, v]) => `${v} ${k}`)
            .join(', ') || 'no related records'
        }`,
    );

    return {
      success: true,
      contact: updated,
      mergedContactId: mergedId,
      mergeId: String(ledger._id),
      reparented,
      fieldChoices: choices,
    };
  }

  /**
   * Reverse a merge: restore the loser and move its rows back.
   *
   * Only the references this merge actually moved are moved back — the ledger's
   * `reparented` receipt is what makes that possible. Field values on the
   * survivor are NOT rolled back: agents will have edited the survivor since,
   * and reverting those edits would destroy work that has nothing to do with the
   * merge. The discarded values are in `fieldChoices` for a human to reapply.
   */
  async unmerge(
    mergeId: string,
  ): Promise<{ success: true; restoredId: string }> {
    const ledger = await this.mergeModel.findById(mergeId).exec();
    if (!ledger) throw new NotFoundException('Merge record not found');
    if (ledger.revertedAt) {
      throw new BadRequestException('This merge has already been reverted');
    }

    const survivorId = String(ledger.survivorId);
    const mergedId = String(ledger.mergedId);
    const [a, b] = [survivorId, mergedId].sort((x, y) => x.localeCompare(y));

    return this.lockService.acquire(
      `lock:contact:merge:${a}:${b}`,
      30_000,
      async () => {
        // Restore the loser before moving rows back, so the rows never point at
        // a still-deleted contact. `restore()` UNSETS deletedAt rather than
        // writing null — a null would still be a present field, and the list
        // filter would keep hiding the contact we just brought back.
        const restored = await this.repository.restore(mergedId);
        if (!restored) {
          throw new NotFoundException(
            'The merged-away contact has been purged and can no longer be restored',
          );
        }

        for (const ref of MERGE_REFERENCES) {
          if (!ledger.reparented?.[ref.collection]) continue;
          await this.reparentOne(ref, survivorId, mergedId);
        }

        ledger.revertedAt = new Date();
        ledger.revertedById = this.userId();
        await ledger.save();

        this.eventEmitter.emit('activity.create', {
          tenantId: this.tenantId(),
          actorId: this.userId(),
          targetType: 'contact',
          targetId: survivorId,
          event: 'unmerge',
          occurredAt: new Date(),
          payload: { mergeId, restoredContactId: mergedId },
        });

        this.logger.log(`Reverted merge ${mergeId}: restored ${mergedId}`);
        return { success: true as const, restoredId: mergedId };
      },
    );
  }

  /** Merge history for a contact, both as survivor and as a merged-away record. */
  async history(contactId: string): Promise<any[]> {
    return this.mergeModel
      .find({
        $or: [{ survivorId: contactId }, { mergedId: contactId }],
      })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean()
      .exec();
  }

  // ── Re-parenting ────────────────────────────────────────────────────────

  private async reparentAll(
    survivorId: string,
    mergedId: string,
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const ref of MERGE_REFERENCES) {
      const moved = await this.reparentOne(ref, mergedId, survivorId);
      if (moved > 0) counts[ref.collection] = moved;
    }
    return counts;
  }

  /** Move every row referencing `fromId` so it references `toId` instead. */
  private async reparentOne(
    ref: ContactReference,
    fromId: string,
    toId: string,
  ): Promise<number> {
    const collection = this.connection.collection(ref.collection);
    const filter = buildReferenceFilter(ref, fromId, this.tenantId());

    try {
      // Paired rows (relationships, affiliations) need conflicts cleared first or
      // the whole updateMany fails on the unique index — see `pairedWith`.
      if (ref.pairedWith) {
        await this.resolvePairConflicts(ref, fromId, toId);
      }

      if (ref.kind === 'objectIdArray') {
        // Add the target then drop the source, as two steps: `$set` of the whole
        // array would clobber other contacts on the same deal/email, and Mongo
        // rejects `$addToSet` and `$pull` on one field in a single update.
        const added = await collection.updateMany(filter, {
          $addToSet: { [ref.field]: new Types.ObjectId(toId) },
        });
        await collection.updateMany(
          { ...filter },
          { $pull: { [ref.field]: new Types.ObjectId(fromId) } as any },
        );
        return added.matchedCount;
      }

      const result = await collection.updateMany(
        filter,
        buildReparentUpdate(ref, toId) as any,
      );
      return result.matchedCount;
    } catch (err) {
      // A single collection failing must not abandon the merge half-done with no
      // record of it: log loudly, keep going, and let the ledger show which
      // collections did move.
      this.logger.error(
        `Failed to re-parent ${ref.collection}.${ref.field} from ${fromId} to ${toId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Soft-delete the loser's paired rows that cannot survive re-parenting.
   *
   * Two cases, both of which would otherwise abort the `updateMany` for the whole
   * collection on the partial unique index:
   *
   *   1. **Self-reference.** "A reports_to B" merged A→B becomes "B reports_to B".
   *      The fact has become vacuous.
   *   2. **Duplicate.** A and B both report to C; re-parenting A's row collides
   *      with B's existing row. The survivor already carries the fact.
   *
   * Soft-deleted rather than removed so an unmerge can bring them back, and so the
   * ledger's re-parent counts stay honest about what moved versus what was dropped.
   */
  private async resolvePairConflicts(
    ref: ContactReference,
    fromId: string,
    toId: string,
  ): Promise<void> {
    const paired = ref.pairedWith!;
    const collection = this.connection.collection(ref.collection);
    const tenantId = new Types.ObjectId(this.tenantId());
    const now = new Date();

    // 1. Rows that would become self-references.
    await collection.updateMany(
      {
        tenantId,
        [ref.field]: new Types.ObjectId(fromId),
        [paired.otherField]: new Types.ObjectId(toId),
        deletedAt: null,
      },
      { $set: { deletedAt: now } },
    );

    // 2. Rows whose (survivor, other, discriminants) twin already exists.
    const losers = await collection
      .find(
        {
          tenantId,
          [ref.field]: new Types.ObjectId(fromId),
          deletedAt: null,
        },
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
    ref: ContactReference,
    contactId: string,
  ): Promise<number> {
    try {
      return await this.connection
        .collection(ref.collection)
        .countDocuments(buildReferenceFilter(ref, contactId, this.tenantId()), {
          limit: 10_000,
        });
    } catch {
      return 0;
    }
  }

  // ── Cache ───────────────────────────────────────────────────────────────

  /**
   * Drop the Redis identity entries that resolve an inbound channel thread to
   * the merged-away contact. Best-effort: a stale entry expires within 24h, so a
   * failure here degrades to the old (wrong) behaviour for a bounded window
   * rather than failing a merge that has already been committed.
   */
  private async invalidateOmniIdentityCache(merged: Contact): Promise<void> {
    const identities = merged.omniIdentities ?? [];
    if (identities.length === 0) return;

    try {
      // The identity cache is keyed by thread, not by sender, so there is no
      // direct key to delete. Conversations were just re-parented, so clearing
      // by conversation is the reliable route.
      const conversations = await this.connection
        .collection('omni_conversations')
        .find(
          {
            tenantId: new Types.ObjectId(this.tenantId()),
            contactId: new Types.ObjectId(merged.id),
          },
          { projection: { channelType: 1, channelAccount: 1, externalId: 1 } },
        )
        .limit(500)
        .toArray();

      const keys = conversations
        .filter((c) => c.channelType && c.externalId)
        .map(
          (c) =>
            `omni:identity:${this.tenantId()}:${c.channelType}:${c.channelAccount}:${c.externalId}`,
        );
      if (keys.length > 0) await this.redis.del(...keys);
    } catch (err) {
      this.logger.warn(
        `Could not invalidate omni identity cache after merge: ` +
          `${err instanceof Error ? err.message : String(err)} — ` +
          'stale entries expire within the 24h TTL.',
      );
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async loadPair(
    survivorId: string,
    mergedId: string,
  ): Promise<{ survivor: Contact; merged: Contact }> {
    // Reads go through the repository so tenant + visibility scoping applies:
    // merge must never be a way to reach a contact you cannot otherwise see.
    const [survivor, merged] = await Promise.all([
      this.repository.findOne({ _id: survivorId }),
      this.repository.findOne({ _id: mergedId }),
    ]);

    if (!survivor || survivor.deletedAt) {
      throw new NotFoundException('Primary contact not found');
    }
    if (!merged || merged.deletedAt) {
      throw new NotFoundException('Target contact not found');
    }
    return { survivor, merged };
  }

  private tenantId(): string {
    return this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
  }

  private userId(): string | undefined {
    return this.cls.get('userId') ?? this.cls.get('user.id');
  }
}

/** All references, exported for the purge path to reuse. */
export { CONTACT_REFERENCES };

function displayName(contact: Contact): string {
  return [contact.firstName, contact.lastName].filter(Boolean).join(' ');
}

/** Strip fields that would make a restored snapshot lie about its own history. */
function stripVolatile(contact: Contact): Record<string, unknown> {
  const snapshot: Record<string, unknown> = { ...(contact as any) };
  delete snapshot.owner;
  delete snapshot.createdBy;
  delete snapshot.updatedBy;
  return snapshot;
}
