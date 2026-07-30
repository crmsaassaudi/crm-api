import { Types } from 'mongoose';

/**
 * The shared vocabulary for "what points at this record".
 *
 * Contacts got a reference registry first, then accounts got a near-identical one, and
 * deals, tickets and tasks each needed a third, fourth and fifth. At two, duplication was
 * the honest choice — the two registries answered different questions and folding them
 * together would have put indirection between "what happens to a deal when I merge its
 * account" and its answer. At five, the *machinery* is plainly the same thing five times:
 * the filter builder, the re-parent update, and the purge policies never differed between
 * domains, only the entries did.
 *
 * So this module owns the mechanics and each domain owns its own table of entries. The
 * per-domain registry stays the place you read to find out what happens to a record; this
 * is only how that table is executed.
 */

/** How a collection stores its pointer. */
export type ReferenceKind =
  /** Single ObjectId field, e.g. `notes.contactId`. */
  | 'objectId'
  /** Array of ObjectIds, e.g. `deals.contactIds`. */
  | 'objectIdArray'
  /** Single string field discriminated by a sibling type field — the activity feed. */
  | 'discriminatedString'
  /** Denormalised sub-document, e.g. `tasks.relatedTo`. */
  | 'relatedTo';

/**
 * What a merge does with the reference.
 *
 * `keep` exists for the audit trail: it records what happened to a specific id, and
 * re-pointing it at the survivor would falsify history.
 */
export type MergePolicy = 'reparent' | 'keep';

/**
 * What a purge does with the reference.
 *
 *   cascade — the row exists only to describe the record (timeline entries, affiliations).
 *   detach  — the row has independent value; null the pointer and keep the row. Revenue,
 *             support history and people must survive the purge of what they pointed at.
 *   pull    — the row references several records; drop this one, and delete the row only
 *             once it references nothing.
 *   keep    — compliance evidence outlives its subject.
 */
export type PurgePolicy = 'cascade' | 'detach' | 'pull' | 'keep';

export interface EntityReference {
  /** Mongo collection name. Not type-checked — each registry's spec pins it. */
  collection: string;
  /** Field holding the reference. */
  field: string;
  kind: ReferenceKind;
  /**
   * For `discriminatedString` and `relatedTo`: the sibling field and value that scope the
   * match to this entity type. `activity_logs` and `tasks.relatedTo` both hold rows for
   * every kind of record, so without it a purge would sweep up other domains' rows.
   */
  discriminator?: { field: string; value: string };
  /**
   * Human label for merge previews and purge logs. A user is about to accept something
   * destructive: "12 tickets" is a decision, "12 rows in tickets" is trivia.
   */
  label: string;
  onMerge: MergePolicy;
  onPurge: PurgePolicy;
  /**
   * Marks a row that is unique per (this entity, other entity) pair, so re-parenting can
   * collide on a partial unique index — which aborts the whole `updateMany` rather than
   * skipping the one offending row.
   */
  pairedWith?: { otherField: string; discriminantFields: string[] };
}

/**
 * The Mongo filter selecting rows that reference `entityId`.
 *
 * `tenantId` is always included: these run on the raw connection, which has no
 * `tenantFilterPlugin` to add it. Getting that wrong would make a purge cross-tenant.
 */
export function buildReferenceFilter(
  ref: EntityReference,
  entityId: string,
  tenantId: string,
): Record<string, any> {
  const tenant = { tenantId: toObjectIdOrString(tenantId) };

  switch (ref.kind) {
    case 'objectId':
    case 'objectIdArray':
      return { ...tenant, [ref.field]: new Types.ObjectId(entityId) };

    case 'discriminatedString':
      return {
        ...tenant,
        [ref.discriminator!.field]: ref.discriminator!.value,
        [ref.field]: entityId,
      };

    case 'relatedTo':
      // `relatedTo._id` is a Mixed field written as a string, and older rows used
      // `relatedTo.id`. TaskRepository queries both shapes, so anything that rewrites
      // them has to match both or it silently misses every legacy row.
      return {
        ...tenant,
        [`${ref.field}.type`]: ref.discriminator!.value,
        $or: [
          { [`${ref.field}._id`]: entityId },
          { [`${ref.field}.id`]: entityId },
        ],
      };
  }
}

/** The update that re-points a matched row at `survivorId`. */
export function buildReparentUpdate(
  ref: EntityReference,
  survivorId: string,
): Record<string, any> {
  switch (ref.kind) {
    case 'objectId':
      return { $set: { [ref.field]: new Types.ObjectId(survivorId) } };

    case 'objectIdArray':
      // `$set` of the whole array would drop every other record in it, and Mongo rejects
      // `$addToSet` and `$pull` on one field in a single update — so the caller runs this
      // and then pulls the loser separately.
      return { $addToSet: { [ref.field]: new Types.ObjectId(survivorId) } };

    case 'discriminatedString':
      return { $set: { [ref.field]: survivorId } };

    case 'relatedTo':
      return { $set: { [`${ref.field}._id`]: survivorId } };
  }
}

/** The update that severs a reference without deleting the row. */
export function buildDetachUpdate(ref: EntityReference): Record<string, any> {
  if (ref.kind === 'relatedTo') {
    // Unset the whole sub-document: a `relatedTo` with a dangling `_id` and a stale
    // `name` is how a purged record keeps appearing in task lists long after it is gone.
    return { $unset: { [ref.field]: '' } };
  }
  return { $set: { [ref.field]: null } };
}

function toObjectIdOrString(id: string): any {
  return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : id;
}

/** References a merge must move onto the surviving record. */
export function mergeReferences(
  references: readonly EntityReference[],
): EntityReference[] {
  return references.filter((ref) => ref.onMerge === 'reparent');
}
