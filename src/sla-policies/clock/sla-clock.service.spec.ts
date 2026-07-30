import { SlaClockService } from './sla-clock.service';

const execQuery = (value: any) => ({
  exec: jest.fn().mockResolvedValue(value),
});

describe('SlaClockService', () => {
  let clocks: any;
  let policies: any;
  let businessHours: any;
  let events: any;
  let service: SlaClockService;

  beforeEach(() => {
    clocks = {
      findOne: jest.fn(),
      find: jest.fn(),
      exists: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      updateOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };
    policies = {
      findAll: jest.fn().mockResolvedValue([
        {
          id: 'policy_frt',
          type: 'first_response',
          enabled: true,
          priority: 10,
          targets: [
            {
              segment: 'default',
              timeValue: 30,
              timeUnit: 'minutes',
            },
          ],
        },
        {
          id: 'policy_next',
          type: 'next_response',
          enabled: true,
          priority: 10,
          targets: [{ segment: 'default', timeValue: 1, timeUnit: 'hours' }],
        },
      ]),
    };
    businessHours = {
      calculateSlaDeadline: jest
        .fn()
        .mockResolvedValue(new Date('2026-07-30T12:30:00.000Z')),
      calculateBusinessMinutesBetween: jest.fn().mockResolvedValue(15),
    };
    events = { emit: jest.fn() };
    service = new SlaClockService(
      clocks,
      policies,
      businessHours,
      events,
      {} as any,
    );
  });

  it('should start a tenant-scoped first-response clock using business hours', async () => {
    clocks.findOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue(execQuery(null)),
      }),
    });
    clocks.create.mockResolvedValue({ _id: 'clock_1' });

    await service.startMetric('tenant_1', 'conversation_1', 'first_response');

    expect(businessHours.calculateSlaDeadline).toHaveBeenCalledWith(
      'tenant_1',
      30,
    );
    expect(clocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        conversationId: 'conversation_1',
        policyId: 'policy_frt',
        metric: 'first_response',
        cycle: 1,
        status: 'running',
      }),
    );
  });

  it('should create a new next-response cycle after every completed cycle', async () => {
    clocks.findOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue(execQuery({ cycle: 3, status: 'met' })),
      }),
    });
    clocks.create.mockResolvedValue({ _id: 'clock_4' });

    await service.startMetric('tenant_1', 'conversation_1', 'next_response');

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

    await expect(
      service.pauseConversation('tenant_1', 'conversation_1'),
    ).resolves.toBe(2);
    expect(clocks.find).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      conversationId: 'conversation_1',
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

  it('should settle an on-time agent response and breach a late response', async () => {
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    clocks.find
      .mockReturnValueOnce(
        execQuery([
          {
            _id: 'clock_1',
            status: 'running',
            dueAt: future,
          },
        ]),
      )
      .mockReturnValueOnce(
        execQuery([
          {
            _id: 'clock_2',
            status: 'running',
            dueAt: past,
          },
        ]),
      );
    clocks.findOneAndUpdate
      .mockReturnValueOnce(
        execQuery({
          _id: 'clock_1',
          tenantId: 'tenant_1',
          conversationId: 'conversation_1',
        }),
      )
      .mockReturnValueOnce(
        execQuery({
          _id: 'clock_2',
          tenantId: 'tenant_1',
          conversationId: 'conversation_1',
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
      'omni.sla.clock_breached',
      expect.objectContaining({ clockId: 'clock_2' }),
    );
  });

  it('should meet response clocks only for agent replies', async () => {
    clocks.find.mockReturnValue(execQuery([]));
    await service.onAgentReply({
      tenantId: 'tenant_1',
      conversationId: 'conversation_1',
      senderType: 'bot',
    });
    expect(clocks.find).not.toHaveBeenCalled();

    await service.onAgentReply({
      tenantId: 'tenant_1',
      conversationId: 'conversation_1',
      senderType: 'agent',
    });
    expect(clocks.find).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      conversationId: 'conversation_1',
      metric: { $in: ['first_response', 'next_response'] },
      status: { $in: ['running', 'paused'] },
    });
  });

  it('should breach due clocks with CAS and emits a metric-specific event', async () => {
    clocks.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockReturnValue({
              setOptions: jest.fn().mockReturnValue(
                execQuery([
                  {
                    _id: 'clock_1',
                    tenantId: 'tenant_1',
                    conversationId: 'conversation_1',
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
          conversationId: 'conversation_1',
          policyId: 'policy_frt',
          metric: 'first_response',
          cycle: 1,
          dueAt: new Date(),
        }),
      ),
    });

    await expect(service.breachDueClocks()).resolves.toBe(1);
    expect(events.emit).toHaveBeenCalledWith(
      'omni.sla.clock_breached',
      expect.objectContaining({
        metric: 'first_response',
        cycle: 1,
      }),
    );
  });
});
