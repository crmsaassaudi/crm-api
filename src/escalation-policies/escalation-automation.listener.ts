import { Injectable, Logger } from '@nestjs/common';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';

/**
 * EscalationAutomationListener — re-emits escalation events under the
 * `automation.trigger` name.
 *
 * ── NOT CONSUMED BY THE ENGINE ─────────────────────────────────────────────
 * The docblock here used to claim "AutomationRulesService listens on
 * `automation.trigger` and evaluates all enabled rules whose trigger matches
 * `conversation.escalated`". It does not: AutomationRulesService has no
 * `@OnEvent` and the `automation_rules` collection has no evaluator anywhere.
 * The only subscriber this event ever reached was an `automation.**` wildcard in
 * AutomationEventListenerService, whose handler expects
 * `{event, object, recordId, data}` — the shape mismatch made every active
 * workflow match and execute against an empty record.
 *
 * The emit is kept so the escalation → automation contract stays visible and
 * anything else can subscribe, but it is a no-op for the workflow engine until
 * a `conversation.escalated` trigger type exists end to end (TriggerConfigDto
 * event enum → publishedTriggerConfig matching → AutomationEventPayload).
 *
 * @see docs/audit/WORKFLOW_AUTOMATION_SECURITY_AUDIT.md — finding H7
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

    // Emitted for future consumers; the workflow engine does not subscribe to
    // `automation.trigger` — see the class docblock.
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
