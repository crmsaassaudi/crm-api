import { SlaClockService } from './sla-clock.service';
import { SlaEvents } from './sla-events';

const execQuery = (value: any) => ({
  exec: jest.fn().mockResolvedValue(value),
});

/** A `findOne(...).select(...).sort(...).lean().exec()` chain. */
const selectSortLean = (value: any) => ({
  select: jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnValue({ lean: jest.fn(() => execQuery(value)) }),
  }),
});

const CONVERSATION = { type: 'conversation' as const, id: 'conversation_1' };
const TICKET = { type: 'ticket' as const, id: 'ticket_1' };

describe('SlaClockService', () => {
  let clocks: any;
  let policies: any;
  let businessHours: any;
  let conversationPort: any;
  let ticketPort: any;
  let events: any;
  let cls: any;
  let service: SlaClockService;

  beforeEach(() => {
    clocks = {
      // Default: no clock still running, which is what the pending-deadline
      // projection reads after every state change. Tests that care about
      // `startMetric` override this with their own chain.
      findOne: jest.fn(() => selectSortLean(null)),
      find: jest.fn(() => ({
        select: jest
          .fn()
          .mockReturnValue({ lean: jest.fn(() => execQuery([])) }),
        exec: jest.fn().mockResolvedValue([]),
      })),
      exists: jest.fn(() => execQuery(false)),
      create: jest.fn(),
      updateMany: jest.fn(() => execQuery({ modifiedCount: 0 })),
      updateOne: jest.fn(() => execQuery({ modifiedCount: 0 })),
      findOneAndUpdate: jest.fn(),
    };
    policies = {
      findApplicable: jest.fn(
        (_tenantId: string, _appliesTo: string, metric: string) => {
          if (metric === 'first_response') {
            return [
              {
                id: 'policy_frt',
                type: 'first_response',
                enabled: true,
                priority: 10,
                targets: [
                  { segment: 'HIGH', timeValue: 15, timeUnit: 'minutes' },
                  { segment: null, timeValue: 30, timeUnit: 'minutes' },
                ],
              },
            ];
          }
          if (metric === 'next_response') {
            return [
              {
                id: 'policy_next',
                type: 'next_response',
                enabled: true,
                priority: 10,
                targets: [{ segment: null, timeValue: 1, timeUnit: 'hours' }],
              },
            ];
          }
          return [];
        },
      ),
    };
    businessHours = {
      calculateSlaDeadline: jest
        .fn()
        .mockResolvedValue(new Date('2026-07-30T12:30:00.000Z')),
      calculateBusinessMinutesBetween: jest.fn().mockResolvedValue(15),
    };
    events = { emit: jest.fn() };
    conversationPort = {
      subjectType: 'conversation',
      loadContext: jest.fn().mockResolvedValue({ segment: null }),
      project: jest.fn().mockResolvedValue(undefined),
      recordAgentResponse: jest.fn().mockResolvedValue(undefined),
    };
    ticketPort = {
      subjectType: 'ticket',
      loadContext: jest.fn().mockResolvedValue({ segment: 'HIGH' }),
      project: jest.fn().mockResolvedValue(undefined),
    };
    // `runWith` executes the callback inline so the tenant-scoped projection
    // writes are observable in the assertions below.
    cls = { runWith: jest.fn((_store: any, fn: () => any) => fn()) };
    service = new SlaClockService(
      clocks,
      policies,
      businessHours,
      events,
      cls,
      [conversationPort, ticketPort],
    );
  });

  it('should start a tenant-scoped first-response clock using business hours', async () => {
    clocks.findOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue(execQuery(null)),
      }),
    });
    clocks.create.mockResolvedValue({ _id: 'clock_1' });

    await service.startMetric('tenant_1', CONVERSATION, 'first_response');

    expect(businessHours.calculateSlaDeadline).toHaveBeenCalledWith(
      'tenant_1',
      30,
    );
    expect(clocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        subjectType: 'conversation',
        subjectId: 'conversation_1',
        policyId: 'policy_frt',
        metric: 'first_response',
        cycle: 1,
        status: 'running',
      }),
    );
  });

  /**
   * The selection bug this guards: `targets[0]` was taken unconditionally, so a
   * policy that spelled out per-priority targets applied whichever one happened
   * to be stored first to every subject in the tenant.
   */
  it('should pick the target whose segment matches the subject over the catch-all', async () => {
    clocks.findOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue(execQuery(null)),
      }),
    });
    clocks.create.mockResolvedValue({ _id: 'clock_1' });

    await service.startMetric('tenant_1', TICKET, 'first_response');

    expect(businessHours.calculateSlaDeadline).toHaveBeenCalledWith(
      'tenant_1',
      15,
    );
    expect(clocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: 'ticket', segment: 'HIGH' }),
    );
  });

  it('should fall back to the catch-all target when no segment matches', async () => {
    ticketPort.loadContext.mockResolvedValue({ segment: 'LOW' });
    clocks.findOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue(execQuery(null)),
      }),
    });
    clocks.create.mockResolvedValue({ _id: 'clock_1' });

    await service.startMetric('tenant_1', TICKET, 'first_response');

    expect(businessHours.calculateSlaDeadline).toHaveBeenCalledWith(
      'tenant_1',
      30,
    );
  });

  it('should not start a clock when the subject no longer exists', async () => {
    ticketPort.loadContext.mockResolvedValue(null);

    await expect(
      service.startMetric('tenant_1', TICKET, 'first_response'),
    ).resolves.toBeNull();
    expect(clocks.create).not.toHaveBeenCalled();
  });

  it('should create a new next-response cycle after every completed cycle', async () => {
    clocks.findOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue(execQuery({ cycle: 3, status: 'met' })),
      }),
    });
    clocks.create.mockResolvedValue({ _id: 'clock_4' });

    await service.startMetric('tenant_1', CONVERSATION, 'next_response');

    expect(clocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'next_response', cycle: 4 }),
    );
  });

  it('should pause every running metric without satisfying it', async () => {
    clocks.find.mockReturnValue(
      execQuery([
        { _id: 'clock_1', dueAt: new Date('2026-07-30T13:00:00.000Z') },
        { _id: 'clock_2', dueAt: new Date('2026-07-30T14:00:00.000Z') },
      ]),
    );
    clocks.updateOne.mockReturnValue(execQuery({ modifiedCount: 1 }));

    await expect(service.pause('tenant_1', CONVERSATION)).resolves.toBe(2);
    expect(clocks.find).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      subjectType: 'conversation',
      subjectId: 'conversation_1',
      status: 'running',
    });
    expect(clocks.updateOne).toHaveBeenCalledWith(
      { _id: 'clock_1', status: 'running' },
      {
        $set: expect.objectContaining({
          status: 'paused',
          remainingMinutesAtPause: 15,
        }),
      },
    );
  });

  it('should settle an on-time agent response and breaches a late one', async () => {
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    const pendingProjection = () => ({
      select: jest.fn().mockReturnValue({ lean: jest.fn(() => execQuery([])) }),
    });
    clocks.find
      .mockReturnValueOnce(
        execQuery([{ _id: 'clock_1', status: 'running', dueAt: future }]),
      )
      .mockReturnValueOnce(pendingProjection())
      .mockReturnValueOnce(
        execQuery([{ _id: 'clock_2', status: 'running', dueAt: past }]),
      )
      .mockReturnValueOnce(pendingProjection())
      .mockReturnValue(pendingProjection());
    clocks.findOneAndUpdate
      .mockReturnValueOnce(
        execQuery({
          _id: 'clock_1',
          tenantId: 'tenant_1',
          subjectType: 'conversation',
          subjectId: 'conversation_1',
        }),
      )
      .mockReturnValueOnce(
        execQuery({
          _id: 'clock_2',
          tenantId: 'tenant_1',
          subjectType: 'conversation',
          subjectId: 'conversation_1',
          policyId: 'policy_frt',
          metric: 'first_response',
          cycle: 1,
          dueAt: past,
        }),
      );

    await service.onAgentReply({
      tenantId: 'tenant_1',
      conversationId: 'conversation_1',
      senderType: 'agent',
    });
    await service.onAgentReply({
      tenantId: 'tenant_1',
      conversationId: 'conversation_1',
      senderType: 'agent',
    });

    expect(clocks.findOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      { _id: 'clock_1', status: 'running' },
      { $set: expect.objectContaining({ status: 'met' }) },
      { new: true },
    );
    expect(clocks.findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      { _id: 'clock_2', status: 'running' },
      { $set: expect.objectContaining({ status: 'breached' }) },
      { new: true },
    );
    expect(events.emit).toHaveBeenCalledWith(
      SlaEvents.BREACHED,
      expect.objectContaining({
        clockId: 'clock_2',
        subjectType: 'conversation',
      }),
    );
  });

  it('should record the first agent response even when no SLA policy applies', async () => {
    policies.findApplicable.mockResolvedValue([]);

    await service.onAgentReply({
      tenantId: 'tenant_1',
      conversationId: 'conversation_1',
      senderType: 'agent',
      senderId: 'agent_7',
    });

    // First Response Time is a business fact, not an SLA artefact: a tenant
    // that has configured no policy must still be able to report on it. It is
    // credited to whoever sent it, not to the current assignee — a transfer
    // must not move the work onto whoever happens to hold it later.
    expect(conversationPort.recordAgentResponse).toHaveBeenCalledWith(
      'tenant_1',
      'conversation_1',
      expect.any(Date),
      'agent_7',
    );
  });

  it('should ignore bot replies entirely', async () => {
    await service.onAgentReply({
      tenantId: 'tenant_1',
      conversationId: 'conversation_1',
      senderType: 'bot',
    });

    expect(conversationPort.recordAgentResponse).not.toHaveBeenCalled();
    expect(clocks.find).not.toHaveBeenCalled();
  });

  it('should breach due clocks with CAS and emits one subject-tagged event', async () => {
    clocks.find.mockReturnValueOnce({
      select: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockReturnValue({
              setOptions: jest.fn().mockReturnValue(
                execQuery([
                  {
                    _id: 'clock_1',
                    tenantId: 'tenant_1',
                    subjectType: 'ticket',
                    subjectId: 'ticket_1',
                  },
                ]),
              ),
            }),
          }),
        }),
      }),
    });
    clocks.findOneAndUpdate.mockReturnValue({
      setOptions: jest.fn().mockReturnValue(
        execQuery({
          _id: 'clock_1',
          tenantId: 'tenant_1',
          subjectType: 'ticket',
          subjectId: 'ticket_1',
          policyId: 'policy_frt',
          metric: 'first_response',
          cycle: 1,
          dueAt: new Date(),
        }),
      ),
    });

    await expect(service.breachDueClocks()).resolves.toBe(1);

    // The breach reaches the ticket, which is the whole point of the subject
    // port: before it, a ticket could not breach at all.
    expect(ticketPort.project).toHaveBeenCalledWith(
      'tenant_1',
      'ticket_1',
      expect.objectContaining({ breachedAt: expect.any(Date) }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      SlaEvents.BREACHED,
      expect.objectContaining({
        subjectType: 'ticket',
        subjectId: 'ticket_1',
        metric: 'first_response',
        cycle: 1,
      }),
    );
  });

  /**
   * Reopen must cancel the settled cycle. Without it `startMetric` sees a
   * once-per-subject clock already resolved, refuses to restart, and the
   * reopened subject carries the previous cycle's expired deadline — breaching
   * the instant it comes back.
   */
  it('should cancel every clock and clear the breach flag on restartCycle', async () => {
    clocks.findOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue(execQuery(null)),
      }),
    });
    clocks.create.mockResolvedValue({ _id: 'clock_new' });

    await service.restartCycle('tenant_1', TICKET);

    expect(clocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: 'ticket',
        subjectId: 'ticket_1',
        status: { $in: ['running', 'paused', 'met', 'breached'] },
      }),
      { $set: { status: 'cancelled' } },
    );
    expect(ticketPort.project).toHaveBeenCalledWith('tenant_1', 'ticket_1', {
      breachedAt: null,
    });
  });
});
