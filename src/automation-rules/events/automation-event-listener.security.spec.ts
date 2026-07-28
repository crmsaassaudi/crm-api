import { AutomationEventListenerService } from './automation-event-listener.service';
import { AutomationEventPayload } from './automation-event.payload';

/**
 * The listener used to subscribe with the `automation.**` wildcard, which also
 * caught `automation.trigger` (ScheduledTriggerService, EscalationAutomation-
 * Listener) and `automation.note-fallback` — payloads with no event/object/
 * recordId. Mongoose strips undefined filter values, so the trigger lookup
 * collapsed to "every active workflow in the tenant" and executed all of them.
 *
 * It also ran the whole evaluation inline on the emitting process; it now only
 * captures a durable outbox row.
 */
describe('AutomationEventListenerService payload guard', () => {
  const buildListener = () => {
    const outbox = { capture: jest.fn() };
    const listener = new AutomationEventListenerService(outbox as any);
    return { listener, outbox };
  };

  const scheduledTriggerShape = {
    tenantId: 't1',
    triggerType: 'time_based',
    subType: 'ticket.stale',
    entityId: 'tk1',
    entityType: 'ticket',
    payload: { ticketId: 'tk1' },
  } as unknown as AutomationEventPayload;

  it('should never enqueue a payload with no event/object', async () => {
    const { listener, outbox } = buildListener();

    await listener.handleAutomationEvent(scheduledTriggerShape);

    expect(outbox.capture).not.toHaveBeenCalled();
  });

  it.each([
    ['tenantId', { tenantId: undefined }],
    ['event', { event: undefined }],
    ['object', { object: undefined }],
    ['recordId', { recordId: undefined }],
  ])('should ignore a payload missing %s', async (_label, missing) => {
    const { listener, outbox } = buildListener();

    await listener.handleAutomationEvent({
      tenantId: 't1',
      event: 'record_created',
      object: 'Contact',
      recordId: 'c1',
      data: {},
      ...missing,
    } as unknown as AutomationEventPayload);

    expect(outbox.capture).not.toHaveBeenCalled();
  });

  it('should capture a well-formed payload instead of evaluating it inline', async () => {
    const { listener, outbox } = buildListener();
    const payload: AutomationEventPayload = {
      tenantId: 't1',
      event: 'record_created',
      object: 'Contact',
      recordId: 'c1',
      data: { id: 'c1' },
    };

    await listener.handleAutomationEvent(payload);

    expect(outbox.capture).toHaveBeenCalledWith(payload);
  });

  it('should surface a durable capture failure to emitAsync callers', async () => {
    const { listener, outbox } = buildListener();
    outbox.capture.mockRejectedValue(new Error('mongo down'));

    await expect(
      listener.handleAutomationEvent({
        tenantId: 't1',
        event: 'record_created',
        object: 'Contact',
        recordId: 'c1',
        data: {},
      }),
    ).rejects.toThrow('mongo down');
  });
});
