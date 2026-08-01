import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../observability/metrics.service';
import { OutboundReconciliationService } from './outbound-reconciliation.service';

describe('OutboundReconciliationService', () => {
  const now = new Date('2026-07-30T12:00:00.000Z');
  let model: any;
  let config: jest.Mocked<Pick<ConfigService, 'get'>>;
  let events: jest.Mocked<Pick<EventEmitter2, 'emit'>>;
  let metrics: jest.Mocked<
    Pick<MetricsService, 'setGauge' | 'incrementCounter'>
  >;
  let candidates: any[];
  let updateResults: Array<{ modifiedCount: number }>;
  let service: OutboundReconciliationService;
  let deliveryAttempts: {
    markStartedUnknownForMessages: jest.Mock;
  };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    candidates = [];
    updateResults = [];

    const query: any = {
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      setOptions: jest.fn().mockReturnThis(),
      exec: jest.fn().mockImplementation(() => Promise.resolve(candidates)),
    };
    model = {
      find: jest.fn().mockReturnValue(query),
      updateOne: jest.fn().mockImplementation(() => ({
        setOptions: jest.fn().mockReturnThis(),
        exec: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(updateResults.shift() ?? { modifiedCount: 0 }),
          ),
      })),
    };
    config = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'OMNI_OUTBOUND_STALE_SENDING_MS') return '60000';
        if (key === 'OMNI_OUTBOUND_RECONCILIATION_BATCH_SIZE') return '50';
        return undefined;
      }),
    };
    events = { emit: jest.fn() };
    metrics = {
      setGauge: jest.fn(),
      incrementCounter: jest.fn(),
    };
    deliveryAttempts = {
      markStartedUnknownForMessages: jest.fn().mockResolvedValue(0),
    };

    service = new OutboundReconciliationService(
      model,
      config as unknown as ConfigService,
      events as unknown as EventEmitter2,
      metrics as unknown as MetricsService,
      deliveryAttempts as any,
      { acquire: (_k: any, _o: any, fn: any) => fn() } as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should mark stale outbound sends failed without resending and batches realtime events', async () => {
    candidates.push(
      { _id: 'm1', tenantId: 't1', conversationId: 'c1' },
      { _id: 'm2', tenantId: 't1', conversationId: 'c1' },
    );
    updateResults.push({ modifiedCount: 1 }, { modifiedCount: 1 });

    await expect(service.reconcileStuckMessages()).resolves.toBe(2);

    expect(model.find).toHaveBeenCalledWith({
      status: 'sending',
      direction: 'outbound',
      updatedAt: { $lte: new Date('2026-07-30T11:59:00.000Z') },
    });
    expect(model.updateOne).toHaveBeenCalledTimes(2);
    expect(model.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'm1',
        status: 'sending',
        direction: 'outbound',
      }),
      {
        $set: {
          status: 'failed',
          'metadata.deliveryReconciliation': {
            reason: 'delivery_outcome_unknown',
            reconciledAt: now,
            staleAfterMs: 60000,
          },
        },
      },
    );
    expect(events.emit).toHaveBeenCalledWith('livechat.message.status', {
      tenantId: 't1',
      conversationId: 'c1',
      messageIds: ['m1', 'm2'],
      status: 'failed',
    });
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'crm_omni_outbound_reconciled_total',
      { outcome: 'delivery_unknown' },
      2,
    );
    expect(deliveryAttempts.markStartedUnknownForMessages).toHaveBeenCalledWith(
      ['m1', 'm2'],
    );
  });

  it('should not emit a failed status when a concurrent receipt wins the CAS', async () => {
    candidates.push({ _id: 'm1', tenantId: 't1', conversationId: 'c1' });
    updateResults.push({ modifiedCount: 0 });

    await expect(service.reconcileStuckMessages()).resolves.toBe(0);

    expect(events.emit).not.toHaveBeenCalled();
    expect(metrics.incrementCounter).not.toHaveBeenCalled();
    expect(deliveryAttempts.markStartedUnknownForMessages).toHaveBeenCalledWith(
      [],
    );
  });

  it('should use conservative defaults for invalid configuration', async () => {
    config.get.mockReturnValue('-1');

    await expect(service.reconcileStuckMessages()).resolves.toBe(0);

    expect(model.find).toHaveBeenCalledWith(
      expect.objectContaining({
        updatedAt: { $lte: new Date('2026-07-30T11:55:00.000Z') },
      }),
    );
  });
});
