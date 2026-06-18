import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * EscalationAutomationListener — bridges the escalation subsystem with the
 * automation engine.
 *
 * When a conversation is escalated (warning or critical), this listener
 * re-emits the event as an automation trigger so that any automation rule
 * with trigger `conversation.escalated` will fire.
 *
 * Example automation: "When conversation escalated → create ticket → assign to manager"
 */
@Injectable()
export class EscalationAutomationListener {
  private readonly logger = new Logger(EscalationAutomationListener.name);

  constructor(private readonly eventEmitter: EventEmitter2) {}

  @OnEvent('omni.conversation.escalated')
  handleEscalated(event: {
    tenantId: string;
    conversationId: string;
    escalationLevel: 'warning' | 'critical';
    escalationPolicyId: string;
    notifyTarget?: string;
    escalatedAt: Date;
  }) {
    this.logger.log(
      `Bridging escalation to automation trigger: conversation=${event.conversationId} level=${event.escalationLevel}`,
    );

    /**
     * Emit the automation trigger event.
     * AutomationRulesService listens on `automation.trigger` and evaluates
     * all enabled rules whose trigger matches `conversation.escalated`.
     */
    this.eventEmitter.emit('automation.trigger', {
      tenantId: event.tenantId,
      triggerType: 'conversation.escalated',
      entityId: event.conversationId,
      entityType: 'conversation',
      payload: {
        conversationId: event.conversationId,
        escalationLevel: event.escalationLevel,
        escalationPolicyId: event.escalationPolicyId,
        notifyTarget: event.notifyTarget ?? null,
        escalatedAt: event.escalatedAt,
      },
    });
  }
}
