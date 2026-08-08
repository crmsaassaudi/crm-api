import { Injectable, Logger } from '@nestjs/common';
import { Namespace } from 'socket.io';
import { NotificationsService } from '../../notifications/notifications.service';

/**
 * CrmRealtimeGateway — handles CRM-specific real-time events.
 *
 * Responsibilities:
 * - Contact/Account/Deal/Ticket export completion broadcasts
 * - Contact/Account/Deal/Ticket import completion broadcasts
 *
 * These events are CRM module concerns, NOT omni-channel messaging.
 * Extracted from OmniGateway (1,700+ lines) to:
 * - Reduce cognitive load — OmniGateway should only handle omni messaging
 * - Allow independent evolution of CRM vs Omni real-time events
 * - Improve readability and maintainability
 *
 * Design: Plain @Injectable() service, receives Socket.IO Server reference
 * from OmniGateway via setServer(). Shares the same /omni namespace.
 */
@Injectable()
export class CrmRealtimeGateway {
  private readonly logger = new Logger(CrmRealtimeGateway.name);
  private server!: Namespace;

  constructor(private readonly notifications: NotificationsService) {}

  /**
   * Called by OmniGateway.onModuleInit() to share the Socket.IO server reference.
   */
  setServer(server: Namespace): void {
    this.server = server;
  }

  /**
   * Redis pub/sub channel names this service handles.
   */
  static readonly REDIS_CHANNELS = [
    'socket:contact:export:completed',
    'socket:account:export:completed',
    'socket:deal:export:completed',
    'socket:ticket:export:completed',
    'socket:task:export:completed',
    'socket:contact:import:completed',
    'socket:account:import:completed',
    'socket:deal:import:completed',
    'socket:ticket:import:completed',
    // Task reminders. Registered here because a channel published to but not
    // listed is silently dropped by `handleRedisMessage`'s default branch — which
    // is how a reminder could look delivered on the publisher's side and arrive
    // nowhere.
    'socket:task:reminder:due',
    // Deal follow-ups that have come due. Same reasoning as above.
    'socket:deal:follow-up:due',
    // Automation `internal_notification` action. Same reasoning as above.
    'socket:automation:notification',
    // A conversation that breached its SLA and escalated to a supervisor. The
    // escalation processor used to emit `omni.escalation.notify`, an event with
    // no listener, so the "notify a manager" action of every escalation policy
    // reached nobody while the processor logged that it had.
    'socket:omni:escalation:notify',
    // A conversation about to be auto-resolved for inactivity. Same shape of
    // defect: `omni.auto_resolve.warning` had no listener, so the agent was
    // never warned before their conversation closed underneath them.
    'socket:omni:auto_resolve:warning',
  ] as const;

  /**
   * Route a Redis pub/sub message to the appropriate handler.
   * Called by OmniGateway's Redis subscriber.
   */
  handleRedisMessage(channel: string, event: any): boolean {
    switch (channel) {
      case 'socket:contact:export:completed':
        this.handleContactExportCompleted(event);
        return true;
      case 'socket:account:export:completed':
        this.handleModuleExportCompleted('account', event);
        return true;
      case 'socket:deal:export:completed':
        this.handleModuleExportCompleted('deal', event);
        return true;
      case 'socket:ticket:export:completed':
        this.handleModuleExportCompleted('ticket', event);
        return true;
      case 'socket:task:export:completed':
        this.handleModuleExportCompleted('task', event);
        return true;
      case 'socket:contact:import:completed':
        this.handleContactImportCompleted(event);
        return true;
      case 'socket:account:import:completed':
        this.handleModuleImportCompleted('account', event);
        return true;
      case 'socket:deal:import:completed':
        this.handleModuleImportCompleted('deal', event);
        return true;
      case 'socket:ticket:import:completed':
        this.handleModuleImportCompleted('ticket', event);
        return true;
      case 'socket:task:reminder:due':
        this.handleTaskReminderDue(event);
        return true;
      case 'socket:deal:follow-up:due':
        this.handleDealFollowUpDue(event);
        return true;
      case 'socket:automation:notification':
        this.handleAutomationNotification(event);
        return true;
      case 'socket:omni:escalation:notify':
        this.handleEscalationNotify(event);
        return true;
      case 'socket:omni:auto_resolve:warning':
        this.handleAutoResolveWarning(event);
        return true;
      default:
        return false;
    }
  }

  /**
   * Tell a supervisor that a conversation has escalated to them.
   *
   * Delivered to `agent:{targetUserId}` rather than the tenant room: an
   * escalation names one person, and broadcasting "your attention is needed" to
   * everyone is how an alert stops being read.
   */
  private handleEscalationNotify(event: {
    tenantId: string;
    conversationId: string;
    targetUserId: string;
    message: string;
    escalationPolicyId: string;
  }) {
    if (!event.targetUserId) return;
    this.logger.warn(
      `Escalation notice → agent:${event.targetUserId} ` +
        `(conversation=${event.conversationId}, policy=${event.escalationPolicyId})`,
    );
    this.server.to(`agent:${event.targetUserId}`).emit('omni:escalation', {
      conversationId: event.conversationId,
      message: event.message,
      escalationPolicyId: event.escalationPolicyId,
    });
    void this.notifications.create({
      tenantId: event.tenantId,
      userId: event.targetUserId,
      type: 'escalation',
      title: 'Conversation escalated to you',
      body: event.message,
      link: { type: 'Conversation', id: event.conversationId },
    });
  }

  /**
   * Warn the assigned agent that a conversation is about to auto-resolve.
   *
   * To the assignee only. With no assignee there is nobody to warn, and the
   * conversation closing is not news to anyone else.
   */
  private handleAutoResolveWarning(event: {
    tenantId: string;
    conversationId: string;
    assignedAgentId: string | null;
    resolvesAt: string;
  }) {
    if (!event.assignedAgentId) return;
    this.server
      .to(`agent:${event.assignedAgentId}`)
      .emit('omni:auto_resolve:warning', {
        conversationId: event.conversationId,
        resolvesAt: event.resolvesAt,
      });
    void this.notifications.create({
      tenantId: event.tenantId,
      userId: event.assignedAgentId,
      type: 'auto_resolve_warning',
      title: 'Conversation about to auto-resolve',
      link: { type: 'Conversation', id: event.conversationId },
    });
  }

  /**
   * Broadcast a workflow notification to the tenant room.
   *
   * Sent to the tenant room with `recipientIds` in the payload, matching how task
   * reminders and export completion are delivered — the client filters. The
   * notice carries no record data beyond a title and message the workflow author
   * wrote, so it is no more sensitive than the workflow itself.
   */
  private handleAutomationNotification(event: {
    tenantId: string;
    recipientIds: string[];
    title: string;
    message: string;
    workflowId: string;
    recordType: string;
    recordId: string;
  }) {
    const room = `tenant:${event.tenantId}`;
    this.logger.log(
      `Broadcasting automation notification to room=${room} ` +
        `(workflow=${event.workflowId}, recipients=${event.recipientIds?.length ?? 0})`,
    );
    this.server.to(room).emit('automation:notification', {
      recipientIds: event.recipientIds,
      title: event.title,
      message: event.message,
      workflowId: event.workflowId,
      recordType: event.recordType,
      recordId: event.recordId,
    });
    for (const recipientId of event.recipientIds ?? []) {
      void this.notifications.create({
        tenantId: event.tenantId,
        userId: recipientId,
        type: 'automation',
        title: event.title,
        body: event.message,
        link:
          event.recordType && event.recordId
            ? { type: event.recordType, id: event.recordId }
            : null,
      });
    }
  }

  /**
   * Broadcast a due task reminder to the tenant room.
   *
   * Sent to the tenant room with `ownerId` in the payload rather than to a
   * per-user room, matching how export completion is delivered — the client
   * filters. A reminder is not sensitive beyond the task itself, which the owner
   * can already read.
   */
  private handleTaskReminderDue(event: {
    tenantId: string;
    taskId: string;
    ownerId: string | null;
    title: string;
    dueDate: string;
    priority: string;
  }) {
    const room = `tenant:${event.tenantId}`;
    this.logger.log(
      `Broadcasting task reminder to room=${room} (task=${event.taskId}, owner=${event.ownerId})`,
    );
    this.server.to(room).emit('task:reminder:due', {
      taskId: event.taskId,
      ownerId: event.ownerId,
      title: event.title,
      dueDate: event.dueDate,
      priority: event.priority,
    });
    if (event.ownerId) {
      void this.notifications.create({
        tenantId: event.tenantId,
        userId: event.ownerId,
        type: 'task_reminder',
        title: `Reminder: ${event.title}`,
        link: { type: 'Task', id: event.taskId },
      });
    }
  }

  /**
   * Broadcast a due deal follow-up to the tenant room.
   *
   * Same delivery shape as the task reminder above: tenant room plus `ownerId`
   * in the payload, client-side filtering. The notice carries no more than the
   * deal's own headline fields, which the owner can already read.
   */
  private handleDealFollowUpDue(event: {
    tenantId: string;
    dealId: string;
    ownerId: string | null;
    title: string;
    value: number;
    currency: string;
    pipelineId: string;
    stageId: string;
    dueAt: string;
  }) {
    const room = `tenant:${event.tenantId}`;
    this.logger.log(
      `Broadcasting deal follow-up to room=${room} (deal=${event.dealId}, owner=${event.ownerId})`,
    );
    this.server.to(room).emit('deal:follow-up:due', {
      dealId: event.dealId,
      ownerId: event.ownerId,
      title: event.title,
      value: event.value,
      currency: event.currency,
      pipelineId: event.pipelineId,
      stageId: event.stageId,
      dueAt: event.dueAt,
    });
    if (event.ownerId) {
      void this.notifications.create({
        tenantId: event.tenantId,
        userId: event.ownerId,
        type: 'deal_follow_up',
        title: `Follow up: ${event.title}`,
        link: { type: 'Deal', id: event.dealId },
      });
    }
  }

  // Export handlers

  /**
   * Broadcast contact export completion to the tenant room.
   */
  private handleContactExportCompleted(event: {
    tenantId: string;
    userId: string;
    downloadUrl: string;
    expiresAt: string;
    recordCount: number;
  }) {
    const room = `tenant:${event.tenantId}`;
    this.logger.log(
      `Broadcasting contact export completed to room=${room} (user=${event.userId}, records=${event.recordCount})`,
    );
    this.server.to(room).emit('contact:export:completed', {
      userId: event.userId,
      downloadUrl: event.downloadUrl,
      expiresAt: event.expiresAt,
      recordCount: event.recordCount,
    });
  }

  /**
   * Generic handler for account/deal/ticket export completion events.
   */
  private handleModuleExportCompleted(
    module: 'account' | 'deal' | 'ticket' | 'task',
    event: {
      tenantId: string;
      userId: string;
      downloadUrl: string;
      expiresAt: string;
      recordCount: number;
    },
  ) {
    const room = `tenant:${event.tenantId}`;
    this.logger.log(
      `Broadcasting ${module} export completed to room=${room} (user=${event.userId}, records=${event.recordCount})`,
    );
    this.server.to(room).emit(`${module}:export:completed`, {
      userId: event.userId,
      downloadUrl: event.downloadUrl,
      expiresAt: event.expiresAt,
      recordCount: event.recordCount,
    });
  }

  // Import handlers

  /**
   * Broadcast contact import completion to the user who triggered it.
   * Unlike export (tenant-wide), import results are only meaningful to the
   * initiating user, so we emit to the `agent:${userId}` room.
   */
  private handleContactImportCompleted(event: {
    tenantId: string;
    userId: string;
    jobId: string;
    fileName?: string;
    summary: {
      total: number;
      inserted: number;
      updated: number;
      skipped: number;
      errors: number;
    };
    reportUrl?: string;
  }) {
    const room = `agent:${event.userId}`;
    this.logger.log(
      `Broadcasting contact import completed to room=${room}, jobId=${event.jobId}`,
    );
    this.server.to(room).emit('contact:import:completed', {
      jobId: event.jobId,
      fileName: event.fileName,
      summary: event.summary,
      reportUrl: event.reportUrl,
    });
  }

  /**
   * Generic handler for account/deal/ticket import completion events.
   * Emits to the agent:${userId} room with module-prefixed event name.
   */
  private handleModuleImportCompleted(
    module: 'account' | 'deal' | 'ticket',
    event: {
      tenantId: string;
      userId: string;
      jobId: string;
      fileName?: string;
      summary: {
        total: number;
        inserted: number;
        updated: number;
        skipped: number;
        errors: number;
      };
      reportUrl?: string;
    },
  ) {
    const room = `agent:${event.userId}`;
    this.logger.log(
      `Broadcasting ${module} import completed to room=${room}, jobId=${event.jobId}`,
    );
    this.server.to(room).emit(`${module}:import:completed`, {
      jobId: event.jobId,
      fileName: event.fileName,
      summary: event.summary,
      reportUrl: event.reportUrl,
    });
  }
}
