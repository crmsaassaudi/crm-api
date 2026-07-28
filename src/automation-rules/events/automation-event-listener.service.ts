import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AutomationEventPayload } from './automation-event.payload';
import { AutomationOutboxService } from './automation-outbox.service';

/**
 * AutomationEventListenerService — the Automation Engine's entry point.
 *
 * It validates the emitted payload and hands it to the trigger queue. That is
 * all it does: workflow matching, condition evaluation and DAG traversal happen
 * in `AutomationTriggerProcessor` / `TriggerEvaluatorService`.
 *
 * It used to do all of that here, synchronously on the emitting process. Because
 * `EventEmitter2.emit` is fire-and-forget and these handlers are async, every
 * `PATCH /contacts/:id` ended up paying for the workflow lookup, the
 * loop-prevention Redis round-trips and the execution-log writes of every
 * matching workflow on its own event loop, after the response had been sent — and
 * a crash in that window lost the automation with no record that it should have
 * run.
 *
 * @see docs/audit/WORKFLOW_AUTOMATION_SECURITY_AUDIT.md — finding M5
 */
@Injectable()
export class AutomationEventListenerService {
  private readonly logger = new Logger(AutomationEventListenerService.name);

  constructor(private readonly outbox: AutomationOutboxService) {}

  // ── Trigger-event listeners ───────────────────────────────────────────
  //
  // Subscribed per (event, object) rather than with a wildcard. `automation.**`
  // also swallowed `automation.trigger` (emitted by ScheduledTriggerService and
  // EscalationAutomationListener) and `automation.note-fallback`, whose payloads
  // have no `event`/`object`/`recordId`. Mongoose strips `undefined` query
  // values, so `findActiveByTrigger(tenantId, undefined, undefined)` collapsed
  // to `{tenantId, status:'active'}` — EVERY active workflow matched and was
  // executed hourly against an empty record, flooding the DLQ with
  // schema-invalid jobs and writing bogus execution history.

  @OnEvent('automation.record_created.Lead')
  @OnEvent('automation.record_created.Contact')
  @OnEvent('automation.record_created.Ticket')
  @OnEvent('automation.record_created.Deal')
  @OnEvent('automation.record_created.Account')
  @OnEvent('automation.record_created.Task')
  @OnEvent('automation.record_created.Conversation')
  @OnEvent('automation.record_created.Message')
  @OnEvent('automation.field_updated.Lead')
  @OnEvent('automation.field_updated.Contact')
  @OnEvent('automation.field_updated.Ticket')
  @OnEvent('automation.field_updated.Deal')
  @OnEvent('automation.field_updated.Account')
  @OnEvent('automation.field_updated.Task')
  @OnEvent('automation.field_updated.Conversation')
  @OnEvent('automation.field_updated.Message')
  async handleAutomationEvent(payload: AutomationEventPayload): Promise<void> {
    const { tenantId, event, object, recordId } = payload;

    // Defence in depth against a malformed emit: a partial payload must not be
    // allowed to widen the trigger query into "all active workflows".
    if (!tenantId || !event || !object || !recordId) {
      this.logger.error(
        `[Event] Ignoring malformed automation payload: ` +
          `tenant=${tenantId ?? 'missing'} event=${event ?? 'missing'} ` +
          `object=${object ?? 'missing'} record=${recordId ?? 'missing'}`,
      );
      return;
    }

    try {
      await this.outbox.capture(payload);
    } catch (error: any) {
      this.logger.error(
        `[Event] Failed to persist ${event}.${object} for record ${recordId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
