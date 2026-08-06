import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { AssignmentScope, CommitPort } from '../../core/ports';

const COLLECTIONS: Record<string, string> = {
  Lead: 'contacts',
  Contact: 'contacts',
  Account: 'accounts',
  Ticket: 'tickets',
  Task: 'tasks',
  Deal: 'deals',
};

/**
 * Default commit for CRM records: set `ownerId`.
 *
 * Callers that must go through the CRM update service — automation, so that
 * field-level authorisation, activity logging and automation breadcrumbs still
 * apply — pass their own commit callback on the request instead. Reserve/release
 * stays in the core either way, so neither path can leak a reservation.
 *
 * This default only *claims* an unowned record — the filter requires `ownerId`
 * to still be null/absent at write time. It is not a general-purpose
 * reassignment primitive: deliberately overwriting an existing owner belongs to
 * a caller that knows (and can attest to) the previous owner, via its own
 * `request.commit` override — the same pattern the conversation side already
 * uses for targeted handoff. Without this, two concurrent decisions racing to
 * claim the same record could both report `matchedCount > 0` and neither would
 * ever see a lost race.
 */
/** Collections carrying `ownerAssignedExplicitly`. See the claim filter below. */
const OWNER_INTENT_COLLECTIONS: ReadonlySet<string> = new Set(['deals']);

@Injectable()
export class RecordCommitPort implements CommitPort {
  private readonly logger = new Logger(RecordCommitPort.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  async commit(
    scope: AssignmentScope,
    assigneeId: string,
    _groupId: string | null,
  ): Promise<boolean> {
    const collection = COLLECTIONS[scope.objectType];
    if (!collection || !scope.entityId) {
      this.logger.error(
        `Cannot commit assignment: objectType=${scope.objectType} entityId=${scope.entityId}`,
      );
      return false;
    }
    if (!Types.ObjectId.isValid(scope.entityId)) return false;

    // Collections that record whether a human chose the owner.
    //
    // The claim below requires the record to still be unowned, but every insert
    // is stamped with its creator — so on those collections "unowned" is never
    // true and auto-assignment could never commit. Where the intent flag exists,
    // a defaulted owner is claimable and a deliberate one is not.
    const tracksOwnerIntent = OWNER_INTENT_COLLECTIONS.has(collection);

    const res = await this.connection.collection(collection).updateOne(
      {
        _id: new Types.ObjectId(scope.entityId),
        tenantId: Types.ObjectId.isValid(scope.tenantId)
          ? new Types.ObjectId(scope.tenantId)
          : scope.tenantId,
        // Claim-only CAS: refuse to overwrite a record someone else already
        // owns. Without this, matchedCount was true regardless of the prior
        // owner, so a lost race was never detected or released.
        $or: [
          { ownerId: null },
          { ownerId: { $exists: false } },
          ...(tracksOwnerIntent ? [{ ownerAssignedExplicitly: false }] : []),
          ...(scope.commandId
            ? [{ lastAssignmentCommandId: scope.commandId }]
            : []),
        ],
      },
      {
        $set: {
          ownerId: Types.ObjectId.isValid(assigneeId)
            ? new Types.ObjectId(assigneeId)
            : assigneeId,
          updatedAt: new Date(),
          // Flipping the flag is what keeps this a one-shot claim: a second
          // concurrent decision no longer matches the `$or` above.
          ...(tracksOwnerIntent ? { ownerAssignedExplicitly: true } : {}),
          ...(scope.commandId
            ? { lastAssignmentCommandId: scope.commandId }
            : {}),
        },
      },
    );

    // matchedCount 0 means the record is gone, belongs to another tenant, or
    // was already claimed by a concurrent decision. Reported as a lost race so
    // the core releases the reservation.
    return res.matchedCount > 0;
  }

  /** Persist durable team queue membership for an unassigned CRM record. */
  async park(scope: AssignmentScope, groupId: string): Promise<void> {
    if (!scope.entityId) return;
    const tenantId = Types.ObjectId.isValid(scope.tenantId)
      ? new Types.ObjectId(scope.tenantId)
      : scope.tenantId;
    await this.connection.collection('assignment_queue_items').updateOne(
      {
        tenantId,
        objectType: scope.objectType,
        entityId: scope.entityId,
      },
      {
        $set: {
          groupId: Types.ObjectId.isValid(groupId)
            ? new Types.ObjectId(groupId)
            : groupId,
          status: 'queued',
          priority: scope.queuePriority ?? 50,
          slaDueAt: scope.slaDueAt ?? null,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          tenantId,
          objectType: scope.objectType,
          entityId: scope.entityId,
          queuedAt: new Date(),
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  async complete(scope: AssignmentScope): Promise<void> {
    if (!scope.entityId) return;
    await this.connection.collection('assignment_queue_items').deleteOne({
      tenantId: Types.ObjectId.isValid(scope.tenantId)
        ? new Types.ObjectId(scope.tenantId)
        : scope.tenantId,
      objectType: scope.objectType,
      entityId: scope.entityId,
    });
  }
}
