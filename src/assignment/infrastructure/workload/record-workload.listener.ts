import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { AssignmentObjectType } from '../../domain/assignment.types';
import { ZsetReservationService } from '../reservation/zset-reservation.service';

interface EntityLifecycleEvent {
  tenantId?: string;
  entityType?: string;
  entityId?: string;
  oldSnapshot?: Record<string, any>;
  newSnapshot?: Record<string, any>;
}

const ENTITY_TYPES: Record<string, AssignmentObjectType> = {
  CONTACT: 'Contact',
  ACCOUNT: 'Account',
  TICKET: 'Ticket',
  TASK: 'Task',
  DEAL: 'Deal',
};

function idOf(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'object' && value && '_id' in value) {
    return String((value as any)._id);
  }
  return String(value);
}

function isActive(
  objectType: AssignmentObjectType,
  snapshot?: Record<string, any>,
): boolean {
  if (!snapshot || snapshot._deleted || snapshot.deletedAt) return false;
  if (objectType === 'Ticket') return !snapshot.closedAt;
  if (objectType === 'Task') return !snapshot.completedAt;
  if (objectType === 'Deal') return !snapshot.wonAt && !snapshot.lostAt;
  return true;
}

/**
 * Keeps the Redis record-workload projection aligned with entity lifecycle
 * changes. Updates only already-seeded members; unseeded members remain owned
 * by the authoritative Mongo aggregate used by RecordLoadPort.
 */
@Injectable()
export class RecordWorkloadListener {
  private readonly logger = new Logger(RecordWorkloadListener.name);

  constructor(
    private readonly reservation: ZsetReservationService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  @OnEvent('contact.created', { async: true })
  @OnEvent('contact.updated', { async: true })
  @OnEvent('account.created', { async: true })
  @OnEvent('account.updated', { async: true })
  @OnEvent('ticket.created', { async: true })
  @OnEvent('ticket.updated', { async: true })
  @OnEvent('task.created', { async: true })
  @OnEvent('task.updated', { async: true })
  @OnEvent('deal.created', { async: true })
  @OnEvent('deal.updated', { async: true })
  async handle(event: EntityLifecycleEvent): Promise<void> {
    const objectType = ENTITY_TYPES[event.entityType ?? ''];
    if (!objectType || !event.tenantId) return;
    // Some legacy events share these names but contain only an entity id.
    if (!event.oldSnapshot && !event.newSnapshot) return;

    const beforeOwner = isActive(objectType, event.oldSnapshot)
      ? idOf(event.oldSnapshot?.ownerId)
      : null;
    const afterOwner = isActive(objectType, event.newSnapshot)
      ? idOf(event.newSnapshot?.ownerId)
      : null;
    if (beforeOwner === afterOwner) return;

    const scope = `${event.tenantId}:${objectType}`;
    const adjustments: Promise<boolean>[] = [];
    if (beforeOwner) {
      adjustments.push(
        this.reservation.adjustIfTracked(scope, beforeOwner, -1),
      );
    }
    if (afterOwner) {
      adjustments.push(this.reservation.adjustIfTracked(scope, afterOwner, 1));
    }
    await Promise.all(adjustments);
    if (event.entityId && (afterOwner || event.newSnapshot?._deleted)) {
      await this.connection.collection('assignment_queue_items').deleteOne({
        tenantId: Types.ObjectId.isValid(event.tenantId)
          ? new Types.ObjectId(event.tenantId)
          : event.tenantId,
        objectType,
        entityId: event.entityId,
      });
    }
    this.logger.debug(
      `Workload projection updated for ${objectType}: ${beforeOwner ?? '-'} -> ${afterOwner ?? '-'}`,
    );
  }
}
