import { TicketSlaProjector } from './ticket-sla.projector';
import type { TicketStatusChangedEvent } from '../domain/ticket-events';

describe('TicketSlaProjector', () => {
  let clocks: any;
  let projector: TicketSlaProjector;

  const SUBJECT = { type: 'ticket', id: 'ticket_1' };

  const statusChange = (
    overrides: Partial<TicketStatusChangedEvent> = {},
  ): TicketStatusChangedEvent => ({
    tenantId: 'tenant_1',
    ticketId: 'ticket_1',
    actorId: 'user_1',
    previousStatus: {
      id: 'open',
      label: 'In Progress',
      isTerminal: false,
      pausesSla: false,
    },
    nextStatus: {
      id: 'resolved',
      label: 'Resolved',
      isTerminal: true,
      terminalKind: 'resolved',
      pausesSla: false,
    },
    isReopen: false,
    ...overrides,
  });

  beforeEach(() => {
    clocks = {
      startResponseAndResolutionClocks: jest.fn().mockResolvedValue(undefined),
      onAgentTurn: jest.fn().mockResolvedValue(undefined),
      onCustomerTurn: jest.fn().mockResolvedValue(undefined),
      pause: jest.fn().mockResolvedValue(0),
      resume: jest.fn().mockResolvedValue(0),
      complete: jest.fn().mockResolvedValue(undefined),
      restartCycle: jest.fn().mockResolvedValue(undefined),
    };
    projector = new TicketSlaProjector(clocks);
  });

  it('should open both clocks when a ticket is created', async () => {
    await projector.onCreated({ tenantId: 'tenant_1', entityId: 'ticket_1' });

    expect(clocks.startResponseAndResolutionClocks).toHaveBeenCalledWith(
      'tenant_1',
      SUBJECT,
    );
  });

  it('should ignore a created event with no tenant or id', async () => {
    await projector.onCreated({ entityId: 'ticket_1' });
    expect(clocks.startResponseAndResolutionClocks).not.toHaveBeenCalled();
  });

  it('should settle the owed response clock on a public reply', async () => {
    const respondedAt = new Date('2026-08-07T09:00:00.000Z');
    await projector.onReplied({
      tenantId: 'tenant_1',
      ticketId: 'ticket_1',
      messageId: 'msg_1',
      authorId: 'user_1',
      respondedAt,
    });

    expect(clocks.onAgentTurn).toHaveBeenCalledWith(
      'tenant_1',
      SUBJECT,
      respondedAt,
    );
  });

  it('should complete the clocks on a terminal status', async () => {
    await projector.onStatusChanged(statusChange());

    expect(clocks.complete).toHaveBeenCalledWith('tenant_1', SUBJECT);
    expect(clocks.restartCycle).not.toHaveBeenCalled();
  });

  /**
   * Without the restart, `startMetric` sees a once-per-subject clock already
   * settled, refuses to reopen it, and the reopened ticket carries the previous
   * cycle's expired deadline — breaching the instant it comes back.
   */
  it('should start a fresh cycle on reopen instead of completing', async () => {
    await projector.onStatusChanged(
      statusChange({
        isReopen: true,
        previousStatus: {
          id: 'resolved',
          label: 'Resolved',
          isTerminal: true,
          pausesSla: false,
        },
        nextStatus: {
          id: 'open',
          label: 'In Progress',
          isTerminal: false,
          terminalKind: null,
          pausesSla: false,
        },
      }),
    );

    expect(clocks.restartCycle).toHaveBeenCalledWith('tenant_1', SUBJECT);
    expect(clocks.complete).not.toHaveBeenCalled();
  });

  it('should pause when entering a status the tenant marked as waiting', async () => {
    await projector.onStatusChanged(
      statusChange({
        nextStatus: {
          id: 'on_hold',
          label: 'Waiting on Customer',
          isTerminal: false,
          terminalKind: null,
          pausesSla: true,
        },
      }),
    );

    expect(clocks.pause).toHaveBeenCalledWith('tenant_1', SUBJECT);
  });

  it('should resume when leaving a waiting status', async () => {
    await projector.onStatusChanged(
      statusChange({
        previousStatus: {
          id: 'on_hold',
          label: 'Waiting on Customer',
          isTerminal: false,
          pausesSla: true,
        },
        nextStatus: {
          id: 'open',
          label: 'In Progress',
          isTerminal: false,
          terminalKind: null,
          pausesSla: false,
        },
      }),
    );

    expect(clocks.resume).toHaveBeenCalledWith('tenant_1', SUBJECT);
  });

  it('should do nothing on an ordinary move between two running statuses', async () => {
    await projector.onStatusChanged(
      statusChange({
        nextStatus: {
          id: 'triaged',
          label: 'Triaged',
          isTerminal: false,
          terminalKind: null,
          pausesSla: false,
        },
      }),
    );

    expect(clocks.pause).not.toHaveBeenCalled();
    expect(clocks.resume).not.toHaveBeenCalled();
    expect(clocks.complete).not.toHaveBeenCalled();
  });
});
