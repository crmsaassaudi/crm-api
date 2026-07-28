import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AssignmentCommandService } from './assignment-command.service';
import { AssignmentObjectType } from '../domain/assignment.types';

interface RecordCreatedEvent {
  tenantId?: string;
  entityType?: string;
  entityId?: string;
  newSnapshot?: Record<string, any>;
}

const OBJECT_TYPES: Record<string, AssignmentObjectType> = {
  CONTACT: 'Contact',
  ACCOUNT: 'Account',
  TICKET: 'Ticket',
  TASK: 'Task',
  DEAL: 'Deal',
};

/**
 * Explicit application-layer trigger for newly created CRM work.
 *
 * It listens only to created events, so the owner update performed by the
 * assignment commit cannot recursively request another assignment. The record
 * adapter's claim-only compare-and-set protects an owner supplied during create
 * and concurrent manual claims.
 */
@Injectable()
export class RecordAutoAssignmentListener {
  private readonly logger = new Logger(RecordAutoAssignmentListener.name);

  constructor(private readonly assignment: AssignmentCommandService) {}

  @OnEvent('contact.created', { async: true })
  @OnEvent('account.created', { async: true })
  @OnEvent('ticket.created', { async: true })
  @OnEvent('task.created', { async: true })
  @OnEvent('deal.created', { async: true })
  async handle(event: RecordCreatedEvent): Promise<void> {
    const objectType = OBJECT_TYPES[event.entityType ?? ''];
    const snapshot = event.newSnapshot;
    if (!objectType || !event.tenantId || !event.entityId || !snapshot) return;
    if (snapshot.ownerId) return;

    try {
      await this.assignment.execute(
        `record-created:${objectType}:${event.entityId}`,
        {
          tenantId: event.tenantId,
          objectType,
          entityId: event.entityId,
          attributes: snapshot,
          source: 'system',
          metadata: { trigger: 'record_created' },
        },
      );
    } catch (err: any) {
      // EventEmitter lifecycle hooks must not make a successful record create
      // fail. The failed decision is observable through logs/metrics and can be
      // retried by a future durable command queue.
      this.logger.error(
        `Auto-assignment failed for ${objectType} ${event.entityId}: ${err.message}`,
      );
    }
  }
}
