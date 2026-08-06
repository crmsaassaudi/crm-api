import { Injectable, Logger } from '@nestjs/common';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';

/**
 * OmniAutomationBridge — bridges omni-channel events into the Automation Engine
 * by re-emitting them as `automation.*` events that the existing
 * AutomationEventListenerService can process.
 *
 * Supported mappings:
 *   - omni.conversation.created        → automation.record_created.Conversation
 *   - omni.conversation.status_changed → automation.field_updated.Conversation
 *   - omni.conversation.assigned       → automation.field_updated.Conversation
 *   - omni.message.persisted           → automation.record_created.Message
 *
 * The Automation Engine already handles:
 *   - Workflow matching via WorkflowOrchestratorService
 *   - Condition evaluation
 *   - Action execution (email, SMS, webhook, update_field, route_to_group)
 *   - Loop prevention and bulk throttling
 *
 * This bridge simply translates omni events into the existing format.
 */
@Injectable()
export class OmniAutomationBridgeService {
  private readonly logger = new Logger(OmniAutomationBridgeService.name);

  constructor(private readonly eventEmitter: EventEmitter2) {}

  /**
   * When a new conversation is created, emit as automation record_created.
   */
  @OnEvent('omni.conversation.created')
  async onConversationCreated(payload: {
    tenantId: string;
    conversationId: string;
    channelType: string;
    senderId: string;
    conversation?: any;
  }): Promise<void> {
    if (!payload.tenantId || !payload.conversationId) return;

    const data = payload.conversation ?? {
      id: payload.conversationId,
      channelType: payload.channelType,
      senderId: payload.senderId,
    };

    this.logger.log(
      `[OmniAutoBridge] conversation.created → automation.record_created.Conversation ` +
        `(tenant=${payload.tenantId}, conv=${payload.conversationId})`,
    );

    await this.eventEmitter.emitAsync(
      'automation.record_created.Conversation',
      {
        tenantId: payload.tenantId,
        event: 'record_created',
        object: 'Conversation',
        recordId: payload.conversationId,
        data: {
          id: payload.conversationId,
          channelType: data.channelType,
          senderId: payload.senderId,
          customerName: data.customer?.name ?? payload.senderId,
          customerEmail: data.customer?.email ?? null,
          customerPhone: data.customer?.phone ?? null,
          status: data.status ?? 'open',
          contactId: data.contactId ?? null,
          ...data,
        },
        automationDepth: 0,
      },
    );
  }

  /**
   * When a conversation's status changes (open → resolved, etc.),
   * emit as automation field_updated.
   */
  @OnEvent('omni.conversation.status_changed')
  async onConversationStatusChanged(payload: {
    tenantId: string;
    conversationId: string;
    status: string;
    oldStatus: string;
    agentId: string | null;
    reason?: string;
    channelType?: string;
  }): Promise<void> {
    if (!payload.tenantId || !payload.conversationId) return;

    this.logger.log(
      `[OmniAutoBridge] conversation.status_changed → automation.field_updated.Conversation ` +
        `(tenant=${payload.tenantId}, conv=${payload.conversationId}, ${payload.oldStatus} → ${payload.status})`,
    );

    await this.eventEmitter.emitAsync('automation.field_updated.Conversation', {
      tenantId: payload.tenantId,
      event: 'field_updated',
      object: 'Conversation',
      recordId: payload.conversationId,
      data: {
        id: payload.conversationId,
        status: payload.status,
        channelType: payload.channelType,
        assignedAgentId: payload.agentId,
        resolveReason: payload.reason,
      },
      changedFields: ['status'],
      automationDepth: 0,
    });
  }

  /**
   * When a conversation changes hands, emit as automation field_updated.
   *
   * The "when an agent is assigned" trigger the workflow builder offers had no
   * bridge, so a workflow keyed on it never ran — assignment was the one
   * conversation lifecycle event the automation engine could not see.
   * `assignedAgentId` is the changed field, which is what a condition on it needs.
   */
  @OnEvent('omni.conversation.assigned')
  async onConversationAssigned(payload: {
    tenantId: string;
    conversationId: string;
    agentId: string | null;
    oldAgentId?: string | null;
    groupId?: string | null;
    channelType?: string;
    reason?: string;
  }): Promise<void> {
    if (!payload.tenantId || !payload.conversationId) return;

    this.logger.log(
      `[OmniAutoBridge] conversation.assigned → automation.field_updated.Conversation ` +
        `(tenant=${payload.tenantId}, conv=${payload.conversationId}, agent=${payload.agentId})`,
    );

    await this.eventEmitter.emitAsync('automation.field_updated.Conversation', {
      tenantId: payload.tenantId,
      event: 'field_updated',
      object: 'Conversation',
      recordId: payload.conversationId,
      data: {
        id: payload.conversationId,
        assignedAgentId: payload.agentId,
        assignedGroupId: payload.groupId ?? null,
        channelType: payload.channelType,
        assignmentReason: payload.reason,
      },
      changedFields: ['assignedAgentId'],
      automationDepth: 0,
    });
  }

  /**
   * When an inbound message is persisted, emit as automation record_created.Message.
   * This enables keyword-based triggers (e.g. "if message contains 'urgent' → create ticket").
   */
  @OnEvent('omni.message.persisted')
  async onMessagePersisted(payload: {
    tenantId: string;
    conversationId: string;
    messageId?: string;
    internalMessageId?: string;
    content?: string;
    messageType?: string;
    senderType?: string;
    senderId?: string;
    channelType?: string;
  }): Promise<void> {
    if (!payload.tenantId || !payload.conversationId) return;

    // Only trigger automations for customer messages (not agent replies)
    if (payload.senderType && payload.senderType !== 'customer') return;

    const messageId =
      payload.internalMessageId ?? payload.messageId ?? 'unknown';

    this.logger.log(
      `[OmniAutoBridge] message.persisted → automation.record_created.Message ` +
        `(tenant=${payload.tenantId}, msg=${messageId})`,
    );

    await this.eventEmitter.emitAsync('automation.record_created.Message', {
      tenantId: payload.tenantId,
      event: 'record_created',
      object: 'Message',
      recordId: messageId,
      data: {
        id: messageId,
        conversationId: payload.conversationId,
        content: payload.content ?? '',
        messageType: payload.messageType ?? 'text',
        senderType: payload.senderType ?? 'customer',
        senderId: payload.senderId,
        channelType: payload.channelType,
      },
      automationDepth: 0,
    });
  }
}
