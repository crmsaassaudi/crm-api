import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { ContactRepository } from '../infrastructure/persistence/document/repositories/contact.repository';
import {
  AccountContactRelationDocument,
  AccountContactRelationSchemaClass,
} from './account-contact-relation.schema';
import {
  CONTACT_RELATION_TYPES,
  ContactRelationDocument,
  ContactRelationSchemaClass,
  ContactRelationType,
  INVERSE_RELATION_LABEL,
} from './contact-relation.schema';

export interface PersonRelationView {
  id: string;
  /** The other person in the relationship, from the asking contact's point of view. */
  contactId: string;
  contactName: string;
  /** Label as it reads FROM the asking contact ('reports_to' vs 'direct_report'). */
  relationLabel: string;
  relationType: ContactRelationType;
  customLabel?: string;
  /** True when the asking contact is the subject of the stored row. */
  isOutgoing: boolean;
  notes?: string;
}

export interface AffiliationView {
  id: string;
  accountId: string;
  accountName: string;
  role?: string;
  title?: string;
  isPrimary: boolean;
  startedAt?: Date;
  endedAt?: Date | null;
  /** False once `endedAt` is set — a former employer, kept for history. */
  isCurrent: boolean;
}

/**
 * ContactRelationsService — the person↔person graph and the person↔company
 * affiliations that `contact.accountId` alone could not express.
 *
 * Two invariants live here rather than being left to callers:
 *
 *   1. **One primary affiliation per contact**, mirrored into `contact.accountId`.
 *      Backed by a partial unique index as well, because a service convention that
 *      two concurrent requests can both satisfy is not a constraint.
 *   2. **One row per relationship, not two.** A relationship is stored once with a
 *      direction and read from either end via `INVERSE_RELATION_LABEL`. Storing
 *      reciprocal pairs is the obvious design and the wrong one: the two rows
 *      drift, deleting one leaves a half-edge, and merge has to reconcile both.
 */
@Injectable()
export class ContactRelationsService {
  private readonly logger = new Logger(ContactRelationsService.name);

  constructor(
    private readonly contacts: ContactRepository,
    private readonly cls: ClsService,
    @InjectModel(ContactRelationSchemaClass.name)
    private readonly relationModel: Model<ContactRelationDocument>,
    @InjectModel(AccountContactRelationSchemaClass.name)
    private readonly affiliationModel: Model<AccountContactRelationDocument>,
  ) {}

  // ── Person ↔ person ─────────────────────────────────────────────────────

  async addPersonRelation(
    fromContactId: string,
    input: {
      toContactId: string;
      relationType: ContactRelationType;
      customLabel?: string;
      notes?: string;
    },
  ): Promise<PersonRelationView> {
    if (fromContactId === input.toContactId) {
      throw new BadRequestException('A contact cannot be related to itself');
    }
    if (!CONTACT_RELATION_TYPES.includes(input.relationType)) {
      throw new BadRequestException(
        `Unknown relation type "${input.relationType}"`,
      );
    }
    if (input.relationType === 'custom' && !input.customLabel?.trim()) {
      throw new BadRequestException(
        'customLabel is required when relationType is "custom"',
      );
    }

    // Both ends read through the repository, so tenant + visibility apply: you
    // cannot link a contact you are not allowed to see, and cannot use this to
    // discover that one exists.
    const [from, to] = await Promise.all([
      this.contacts.findOne({ _id: fromContactId }),
      this.contacts.findOne({ _id: input.toContactId }),
    ]);
    if (!from) throw new NotFoundException('Contact not found');
    if (!to) throw new NotFoundException('Related contact not found');

    // A reciprocal-by-nature relationship must not be storable twice in opposite
    // directions — "A colleague B" and "B colleague A" are the same fact, and the
    // unique index cannot catch it because the pair is ordered.
    if (isSymmetric(input.relationType)) {
      const mirror = await this.relationModel
        .findOne({
          fromContactId: new Types.ObjectId(input.toContactId),
          toContactId: new Types.ObjectId(fromContactId),
          relationType: input.relationType,
          deletedAt: null,
        })
        .lean()
        .exec();
      if (mirror) {
        throw new ConflictException(
          'That relationship already exists in the other direction',
        );
      }
    }

    try {
      const created = await this.relationModel.create({
        tenantId: this.tenantId(),
        fromContactId,
        toContactId: input.toContactId,
        relationType: input.relationType,
        customLabel: input.customLabel?.trim(),
        notes: input.notes,
        createdById: this.userId(),
      });
      return this.toPersonView(created.toObject(), fromContactId, to);
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException('That relationship already exists');
      }
      throw err;
    }
  }

  /**
   * Every relationship touching this contact, read from ITS point of view —
   * rows where it is the subject and rows where it is the object, with the label
   * inverted for the latter.
   */
  async listPersonRelations(contactId: string): Promise<PersonRelationView[]> {
    const contact = await this.contacts.findOne({ _id: contactId });
    if (!contact) throw new NotFoundException('Contact not found');

    const oid = new Types.ObjectId(contactId);
    const rows = await this.relationModel
      .find({
        $or: [{ fromContactId: oid }, { toContactId: oid }],
        deletedAt: null,
      })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean()
      .exec();

    // One batched lookup for the other ends rather than a query per row.
    const otherIds = rows.map((row: any) =>
      String(row.fromContactId) === contactId
        ? String(row.toContactId)
        : String(row.fromContactId),
    );
    const others = await this.loadContactNames(otherIds);

    return rows.map((row: any) =>
      this.toPersonView(row, contactId, undefined, others),
    );
  }

  async removePersonRelation(relationId: string): Promise<void> {
    const result = await this.relationModel
      .updateOne(
        { _id: relationId, deletedAt: null },
        { $set: { deletedAt: new Date() } },
      )
      .exec();
    if (result.matchedCount === 0) {
      throw new NotFoundException('Relationship not found');
    }
  }

  // ── Person ↔ company ────────────────────────────────────────────────────

  async addAffiliation(
    contactId: string,
    input: {
      accountId: string;
      role?: string;
      title?: string;
      isPrimary?: boolean;
      startedAt?: Date;
    },
  ): Promise<AffiliationView> {
    const contact = await this.contacts.findOne({ _id: contactId });
    if (!contact) throw new NotFoundException('Contact not found');

    const existingCount = await this.affiliationModel
      .countDocuments({
        contactId: new Types.ObjectId(contactId),
        deletedAt: null,
      })
      .exec();

    // The first affiliation is primary whether or not the caller said so —
    // otherwise a contact ends up with a company and a null `accountId`, which is
    // the inconsistency this whole model exists to remove.
    //
    // Note this is NOT `input.isPrimary ?? existingCount === 0`: that honours an
    // explicit `isPrimary: false` on the first affiliation and produces exactly
    // the state the previous sentence rules out.
    const isPrimary = existingCount === 0 ? true : (input.isPrimary ?? false);

    if (isPrimary) await this.demoteCurrentPrimary(contactId);

    try {
      const created = await this.affiliationModel.create({
        tenantId: this.tenantId(),
        contactId,
        accountId: input.accountId,
        role: input.role,
        title: input.title,
        isPrimary,
        startedAt: input.startedAt,
        createdById: this.userId(),
      });

      if (isPrimary)
        await this.mirrorPrimaryOntoContact(contactId, input.accountId);

      return this.toAffiliationView(
        created.toObject(),
        await this.loadAccountNames([input.accountId]),
      );
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException(
          'This contact is already affiliated with that company',
        );
      }
      throw err;
    }
  }

  async listAffiliations(contactId: string): Promise<AffiliationView[]> {
    const contact = await this.contacts.findOne({ _id: contactId });
    if (!contact) throw new NotFoundException('Contact not found');

    const rows = await this.affiliationModel
      .find({ contactId: new Types.ObjectId(contactId), deletedAt: null })
      // Primary first, then current before former, then newest.
      .sort({ isPrimary: -1, endedAt: 1, createdAt: -1 })
      .limit(100)
      .lean()
      .exec();

    const names = await this.loadAccountNames(
      rows.map((row: any) => String(row.accountId)),
    );
    return rows.map((row: any) => this.toAffiliationView(row, names));
  }

  /** "Who works at this company?" — for the account detail page. */
  async listAccountContacts(accountId: string): Promise<
    Array<{
      id: string;
      contactId: string;
      contactName: string;
      role?: string;
      title?: string;
      isPrimary: boolean;
      isCurrent: boolean;
    }>
  > {
    const rows = await this.affiliationModel
      .find({ accountId: new Types.ObjectId(accountId), deletedAt: null })
      .sort({ isPrimary: -1, createdAt: -1 })
      .limit(200)
      .lean()
      .exec();

    const names = await this.loadContactNames(
      rows.map((row: any) => String(row.contactId)),
    );

    return rows.map((row: any) => ({
      id: String(row._id),
      contactId: String(row.contactId),
      contactName: names.get(String(row.contactId)) ?? 'Unknown',
      role: row.role,
      title: row.title,
      isPrimary: Boolean(row.isPrimary),
      isCurrent: !row.endedAt,
    }));
  }

  async updateAffiliation(
    affiliationId: string,
    input: {
      role?: string;
      title?: string;
      isPrimary?: boolean;
      startedAt?: Date;
      endedAt?: Date | null;
    },
  ): Promise<AffiliationView> {
    const existing = await this.affiliationModel
      .findOne({ _id: affiliationId, deletedAt: null })
      .lean()
      .exec();
    if (!existing) throw new NotFoundException('Affiliation not found');

    const contactId = String((existing as any).contactId);

    if (input.isPrimary === true && !(existing as any).isPrimary) {
      // Demote before promoting: the partial unique index would reject two
      // primaries, so doing it the other way round fails.
      await this.demoteCurrentPrimary(contactId);
    }

    const updated = await this.affiliationModel
      .findOneAndUpdate(
        { _id: affiliationId },
        {
          $set: {
            ...(input.role !== undefined ? { role: input.role } : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.isPrimary !== undefined
              ? { isPrimary: input.isPrimary }
              : {}),
            ...(input.startedAt !== undefined
              ? { startedAt: input.startedAt }
              : {}),
            ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
          },
        },
        { new: true },
      )
      .lean()
      .exec();

    if (input.isPrimary === true) {
      await this.mirrorPrimaryOntoContact(
        contactId,
        String((updated as any).accountId),
      );
    }

    return this.toAffiliationView(
      updated as any,
      await this.loadAccountNames([String((updated as any).accountId)]),
    );
  }

  async removeAffiliation(affiliationId: string): Promise<void> {
    const existing = await this.affiliationModel
      .findOneAndUpdate(
        { _id: affiliationId, deletedAt: null },
        { $set: { deletedAt: new Date(), isPrimary: false } },
        { new: false },
      )
      .lean()
      .exec();
    if (!existing) throw new NotFoundException('Affiliation not found');

    // Removing the primary must not leave `contact.accountId` pointing at a
    // company the person is no longer linked to. Promote the next affiliation, or
    // clear the mirror if there is none.
    if ((existing as any).isPrimary) {
      const contactId = String((existing as any).contactId);
      const next = await this.affiliationModel
        .findOneAndUpdate(
          { contactId: new Types.ObjectId(contactId), deletedAt: null },
          { $set: { isPrimary: true } },
          { sort: { endedAt: 1, createdAt: -1 }, new: true },
        )
        .lean()
        .exec();

      await this.mirrorPrimaryOntoContact(
        contactId,
        next ? String((next as any).accountId) : null,
      );
    }
  }

  // ── Invariant helpers ───────────────────────────────────────────────────

  private async demoteCurrentPrimary(contactId: string): Promise<void> {
    await this.affiliationModel
      .updateMany(
        {
          contactId: new Types.ObjectId(contactId),
          isPrimary: true,
          deletedAt: null,
        },
        { $set: { isPrimary: false } },
      )
      .exec();
  }

  /**
   * Keep `contact.accountId` equal to the primary affiliation's account.
   *
   * This is the backward-compatibility seam: every existing query, report column,
   * export field and automation condition reads `accountId`, and none of them know
   * this collection exists. Introducing the feature by breaking those readers
   * would be the wrong order of operations. `companyName` is left alone — it is
   * free text a user may have deliberately set to something other than the linked
   * account's name, and silently rewriting it would be a data change disguised as
   * a sync.
   */
  private async mirrorPrimaryOntoContact(
    contactId: string,
    accountId: string | null,
  ): Promise<void> {
    try {
      await this.contacts.update(contactId, { accountId } as any);
    } catch (err) {
      this.logger.warn(
        `Could not mirror the primary affiliation onto contact ${contactId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Views ───────────────────────────────────────────────────────────────

  private toPersonView(
    row: any,
    askingContactId: string,
    known?: { id: string; firstName?: string; lastName?: string },
    names?: Map<string, string>,
  ): PersonRelationView {
    const isOutgoing = String(row.fromContactId) === askingContactId;
    const otherId = isOutgoing
      ? String(row.toContactId)
      : String(row.fromContactId);

    const otherName =
      known && known.id === otherId
        ? [known.firstName, known.lastName].filter(Boolean).join(' ')
        : (names?.get(otherId) ?? 'Unknown');

    return {
      id: String(row._id),
      contactId: otherId,
      contactName: otherName,
      relationType: row.relationType,
      // Read from the other end, the same row means the inverse thing.
      relationLabel: isOutgoing
        ? row.relationType
        : INVERSE_RELATION_LABEL[row.relationType as ContactRelationType],
      customLabel: row.customLabel,
      isOutgoing,
      notes: row.notes,
    };
  }

  private toAffiliationView(
    row: any,
    accountNames: Map<string, string>,
  ): AffiliationView {
    return {
      id: String(row._id),
      accountId: String(row.accountId),
      accountName: accountNames.get(String(row.accountId)) ?? 'Unknown',
      role: row.role,
      title: row.title,
      isPrimary: Boolean(row.isPrimary),
      startedAt: row.startedAt,
      endedAt: row.endedAt ?? null,
      isCurrent: !row.endedAt,
    };
  }

  private async loadContactNames(ids: string[]): Promise<Map<string, string>> {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    if (unique.length === 0) return new Map();

    // Through the model rather than the repository: this is a display-name lookup
    // for records the caller already reached legitimately, and running it through
    // the visibility axes would blank the name of a related contact the user can
    // see referenced but not open — showing "Unknown" where a name belongs.
    const docs = await this.relationModel.db
      .collection('contacts')
      .find(
        {
          _id: { $in: unique.map((id) => new Types.ObjectId(id)) },
          tenantId: new Types.ObjectId(this.tenantId()),
        },
        { projection: { firstName: 1, lastName: 1 } },
      )
      .toArray();

    return new Map(
      docs.map((doc: any) => [
        String(doc._id),
        [doc.firstName, doc.lastName].filter(Boolean).join(' ') || 'Unknown',
      ]),
    );
  }

  private async loadAccountNames(ids: string[]): Promise<Map<string, string>> {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    if (unique.length === 0) return new Map();

    const docs = await this.relationModel.db
      .collection('accounts')
      .find(
        {
          _id: { $in: unique.map((id) => new Types.ObjectId(id)) },
          tenantId: new Types.ObjectId(this.tenantId()),
        },
        { projection: { name: 1 } },
      )
      .toArray();

    return new Map(
      docs.map((doc: any) => [String(doc._id), String(doc.name ?? 'Unknown')]),
    );
  }

  private tenantId(): string {
    return this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
  }

  private userId(): string | undefined {
    return this.cls.get('userId') ?? this.cls.get('user.id');
  }
}

/** Relationship types that mean the same thing read from either end. */
function isSymmetric(type: ContactRelationType): boolean {
  return type === 'colleague' || type === 'household';
}
