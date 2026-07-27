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

    const res = await this.connection.collection(collection).updateOne(
      {
        _id: new Types.ObjectId(scope.entityId),
        tenantId: Types.ObjectId.isValid(scope.tenantId)
          ? new Types.ObjectId(scope.tenantId)
          : scope.tenantId,
        // Claim-only CAS: refuse to overwrite a record someone else already
        // owns. Without this, matchedCount was true regardless of the prior
        // owner, so a lost race was never detected or released.
        $or: [{ ownerId: null }, { ownerId: { $exists: false } }],
      },
      {
        $set: {
          ownerId: Types.ObjectId.isValid(assigneeId)
            ? new Types.ObjectId(assigneeId)
            : assigneeId,
          updatedAt: new Date(),
        },
      },
    );

    // matchedCount 0 means the record is gone, belongs to another tenant, or
    // was already claimed by a concurrent decision. Reported as a lost race so
    // the core releases the reservation.
    return res.matchedCount > 0;
  }

  /**
   * Records have no group-queue field today, so there is nothing to park.
   *
   * Declared explicitly rather than omitted so that the day `assignedGroupId`
   * (or an equivalent) lands on records, this is the one place to implement it.
   */
  park(_scope: AssignmentScope, _groupId: string): Promise<void> {
    return Promise.resolve();
  }
}
