import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import {
  normalizeEmail,
  normalizePhone,
} from '../../common/identity/identity-normalizer';
import {
  ContactIdentityDocument,
  ContactIdentitySchemaClass,
  ContactIdentityType,
} from './contact-identity.schema';

/** One identity as derived from a contact document's arrays. */
interface DerivedIdentity {
  type: ContactIdentityType;
  normalisedValue: string;
  rawValue: string;
  channelType?: string;
}

export interface IdentityConflict {
  type: ContactIdentityType;
  value: string;
  /** The contact that already holds it. */
  heldBy: string;
}

/**
 * Keeps `contact_identities` in step with the authoritative
 * `emails[]` / `phones[]` / `omniIdentities[]` arrays.
 *
 * The arrays stay the source of truth for reads (see the schema comment), so this is a
 * projection: after a contact is written, its identity rows are reconciled to match.
 * Reconcile rather than append — an email removed from the array must stop reserving
 * its value in the unique index, or removing and re-adding an address would fail.
 *
 * Every method is **best-effort and non-throwing except for `assertNoConflicts`**.
 * A projection that can fail a contact write is worse than a projection that lags:
 * the arrays are already saved and already correct, and a drifted mirror is repaired
 * by the backfill script. The one exception is the pre-flight conflict check, which is
 * a deliberate correctness gate the caller opts into.
 */
@Injectable()
export class ContactIdentitySyncService {
  private readonly logger = new Logger(ContactIdentitySyncService.name);

  constructor(
    @InjectModel(ContactIdentitySchemaClass.name)
    private readonly model: Model<ContactIdentityDocument>,
    private readonly cls: ClsService,
  ) {}

  /**
   * Derive the identity set a contact document implies.
   * Exported shape is deterministic, so two calls on equal input reconcile to nothing.
   */
  derive(
    contact: {
      emails?: string[];
      phones?: string[];
      omniIdentities?: Array<{ channelType: string; senderId: string }>;
    },
    defaultCountryCode?: string,
  ): DerivedIdentity[] {
    const out: DerivedIdentity[] = [];
    const seen = new Set<string>();

    const push = (identity: DerivedIdentity) => {
      const key = `${identity.type}:${identity.normalisedValue}`;
      if (!identity.normalisedValue || seen.has(key)) return;
      seen.add(key);
      out.push(identity);
    };

    for (const raw of contact.emails ?? []) {
      if (typeof raw !== 'string') continue;
      push({
        type: 'email',
        normalisedValue: normalizeEmail(raw),
        rawValue: raw,
      });
    }
    for (const raw of contact.phones ?? []) {
      if (typeof raw !== 'string') continue;
      push({
        type: 'phone',
        normalisedValue: normalizePhone(raw, defaultCountryCode),
        rawValue: raw,
      });
    }
    for (const identity of contact.omniIdentities ?? []) {
      if (!identity?.channelType || !identity?.senderId) continue;
      push({
        type: 'omni',
        // Namespaced by channel: the same numeric id can exist on two providers, and
        // a bare senderId would collide them into one person.
        normalisedValue: `${identity.channelType.toLowerCase()}:${identity.senderId}`,
        rawValue: identity.senderId,
        channelType: identity.channelType.toLowerCase(),
      });
    }

    return out;
  }

  /**
   * Pre-flight: would any of these identities collide with another contact's?
   *
   * Backed by the unique index rather than replacing it — this exists to produce a
   * useful error message naming the other contact, which a raw E11000 cannot. The
   * index remains the thing that actually holds under concurrency.
   */
  async findConflicts(
    identities: DerivedIdentity[],
    excludeContactId?: string,
  ): Promise<IdentityConflict[]> {
    if (identities.length === 0) return [];

    const rows = await this.model
      .find({
        normalisedValue: { $in: identities.map((i) => i.normalisedValue) },
        deletedAt: null,
        ...(excludeContactId
          ? { contactId: { $ne: new Types.ObjectId(excludeContactId) } }
          : {}),
      })
      .select({ contactId: 1, type: 1, normalisedValue: 1 })
      .limit(50)
      .lean()
      .exec();

    return rows.map((row: any) => ({
      type: row.type,
      value: row.normalisedValue,
      heldBy: String(row.contactId),
    }));
  }

  /** Throwing form, for a caller that wants the write refused. */
  async assertNoConflicts(
    identities: DerivedIdentity[],
    excludeContactId?: string,
  ): Promise<void> {
    const conflicts = await this.findConflicts(identities, excludeContactId);
    if (conflicts.length > 0) {
      throw new ConflictException({
        message: 'Contact identity conflict',
        conflicts: conflicts.map(
          (c) => `${c.type} ${c.value} already belongs to contact ${c.heldBy}`,
        ),
      });
    }
  }

  /**
   * Reconcile a contact's identity rows to match `identities`.
   *
   * Additions are upserted, disappearances are soft-deleted, and rows that are
   * already correct are left alone so `updatedAt` stays meaningful. Never throws.
   */
  async sync(
    contactId: string,
    identities: DerivedIdentity[],
    options: {
      source?: string;
      session?: ClientSession;
      strict?: boolean;
      tenantId?: string;
      userId?: string;
    } = {},
  ): Promise<{ added: number; removed: number }> {
    try {
      const tenantId = options.tenantId ?? this.tenantId();
      if (!tenantId) return { added: 0, removed: 0 };

      let existingQuery = this.model
        .find({ contactId: new Types.ObjectId(contactId), deletedAt: null })
        .select({ type: 1, normalisedValue: 1 });
      if (options.session)
        existingQuery = existingQuery.session(options.session);
      const existing = await existingQuery.lean().exec();

      const existingKeys = new Set(
        existing.map((row: any) => `${row.type}:${row.normalisedValue}`),
      );
      const wantedKeys = new Set(
        identities.map((i) => `${i.type}:${i.normalisedValue}`),
      );

      const toAdd = identities.filter(
        (i) => !existingKeys.has(`${i.type}:${i.normalisedValue}`),
      );
      const toRemove = existing.filter(
        (row: any) => !wantedKeys.has(`${row.type}:${row.normalisedValue}`),
      );

      if (toAdd.length === 0 && toRemove.length === 0) {
        return { added: 0, removed: 0 };
      }

      const now = new Date();
      const operations: any[] = [];

      for (const identity of toAdd) {
        operations.push(
          options.strict
            ? {
                insertOne: {
                  document: {
                    tenantId,
                    contactId: new Types.ObjectId(contactId),
                    type: identity.type,
                    normalisedValue: identity.normalisedValue,
                    rawValue: identity.rawValue,
                    ...(identity.channelType
                      ? { channelType: identity.channelType }
                      : {}),
                    deletedAt: null,
                    isPrimary: false,
                    verified: false,
                    optIn: null,
                    source: options.source ?? 'sync',
                    createdById: options.userId ?? this.userId(),
                    createdAt: now,
                    updatedAt: now,
                  },
                },
              }
            : {
                updateOne: {
                  filter: {
                    tenantId,
                    contactId: new Types.ObjectId(contactId),
                    type: identity.type,
                    normalisedValue: identity.normalisedValue,
                  },
                  update: {
                    $set: {
                      contactId: new Types.ObjectId(contactId),
                      rawValue: identity.rawValue,
                      ...(identity.channelType
                        ? { channelType: identity.channelType }
                        : {}),
                      deletedAt: null,
                    },
                    $setOnInsert: {
                      isPrimary: false,
                      verified: false,
                      optIn: null,
                      source: options.source ?? 'sync',
                      createdById: options.userId ?? this.userId(),
                    },
                  },
                  upsert: true,
                },
              },
        );
      }

      for (const row of toRemove) {
        operations.push({
          updateOne: {
            filter: { _id: (row as any)._id },
            update: { $set: { deletedAt: now } },
          },
        });
      }

      await this.model.bulkWrite(operations, {
        ordered: false,
        ...(options.session ? { session: options.session } : {}),
      });

      // Make sure each type has exactly one primary — the array's first element is
      // what the rest of the product treats as "the" email/phone, so the mirror
      // should agree with it.
      await this.ensurePrimaries(contactId, identities, options.session);

      return { added: toAdd.length, removed: toRemove.length };
    } catch (err) {
      if (options.strict) {
        if ((err as any)?.code === 11000 || String(err).includes('E11000')) {
          throw new ConflictException('Contact identity conflict');
        }
        throw err;
      }
      // Never fail the contact write for the projection's sake: the arrays are
      // already saved and already correct, and `backfill:contact-identities` repairs
      // drift. A duplicate-key error here means another contact holds the value —
      // which `assertNoConflicts` is the place to surface, not this one.
      this.logger.warn(
        `Identity sync for contact ${contactId} did not complete: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return { added: 0, removed: 0 };
    }
  }

  /** Convenience: derive from a contact document and sync in one call. */
  async syncFromContact(
    contactId: string,
    contact: {
      emails?: string[];
      phones?: string[];
      omniIdentities?: Array<{ channelType: string; senderId: string }>;
    },
    options: {
      source?: string;
      defaultCountryCode?: string;
      session?: ClientSession;
      strict?: boolean;
      tenantId?: string;
      userId?: string;
    } = {},
  ): Promise<void> {
    await this.sync(
      contactId,
      this.derive(contact, options.defaultCountryCode),
      {
        source: options.source,
        session: options.session,
        strict: options.strict,
        tenantId: options.tenantId,
        userId: options.userId,
      },
    );
  }

  /** Every live identity of a contact, primary first. */
  async listForContact(contactId: string): Promise<any[]> {
    return this.model
      .find({ contactId: new Types.ObjectId(contactId), deletedAt: null })
      .sort({ type: 1, isPrimary: -1, createdAt: 1 })
      .lean()
      .exec();
  }

  /** Resolve a contact from a normalised identity value — the resolver's question. */
  async findContactByIdentity(normalisedValue: string): Promise<string | null> {
    const row = await this.model
      .findOne({ normalisedValue, deletedAt: null })
      .select({ contactId: 1 })
      .lean()
      .exec();
    return row ? String((row as any).contactId) : null;
  }

  /**
   * Record consent against ONE identity.
   *
   * The contact-level `emailOptIn` boolean could not express "this address opted out
   * but that one did not", which is the shape actual consent takes.
   */
  async setConsent(identityId: string, optIn: boolean | null): Promise<void> {
    await this.model
      .updateOne(
        { _id: identityId, deletedAt: null },
        {
          $set: {
            optIn,
            optInAt: optIn === null ? null : new Date(),
          },
        },
      )
      .exec();
  }

  /** Mark an identity verified, or bounced. Both are per-identity facts. */
  async setDeliverability(
    identityId: string,
    state: { verified?: boolean; bounced?: boolean },
  ): Promise<void> {
    const set: Record<string, unknown> = {};
    if (state.verified !== undefined) set.verified = state.verified;
    if (state.bounced !== undefined) {
      set.bouncedAt = state.bounced ? new Date() : null;
    }
    if (Object.keys(set).length === 0) return;

    await this.model
      .updateOne({ _id: identityId, deletedAt: null }, { $set: set })
      .exec();
  }

  /**
   * One primary per (contact, type), matching the array order the rest of the
   * product already treats as significant.
   */
  private async ensurePrimaries(
    contactId: string,
    identities: DerivedIdentity[],
    session?: ClientSession,
  ): Promise<void> {
    const firstOfType = new Map<ContactIdentityType, string>();
    for (const identity of identities) {
      if (!firstOfType.has(identity.type)) {
        firstOfType.set(identity.type, identity.normalisedValue);
      }
    }
    if (firstOfType.size === 0) return;

    const oid = new Types.ObjectId(contactId);
    for (const [type, normalisedValue] of firstOfType) {
      // Demote before promoting: the partial unique index rejects two primaries, so
      // the other order fails.
      let demote = this.model.updateMany(
        { contactId: oid, type, isPrimary: true, deletedAt: null },
        { $set: { isPrimary: false } },
      );
      if (session) demote = demote.session(session);
      await demote.exec();
      let promote = this.model.updateOne(
        { contactId: oid, type, normalisedValue, deletedAt: null },
        { $set: { isPrimary: true } },
      );
      if (session) promote = promote.session(session);
      await promote.exec();
    }
  }

  private tenantId(): string | undefined {
    return this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
  }

  private userId(): string | undefined {
    return this.cls.get('userId') ?? this.cls.get('user.id');
  }
}
