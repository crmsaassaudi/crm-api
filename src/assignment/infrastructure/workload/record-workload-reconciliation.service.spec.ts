/* eslint-disable @typescript-eslint/require-await */
import { RecordWorkloadReconciliationService } from './record-workload-reconciliation.service';

describe('RecordWorkloadReconciliationService', () => {
  const reservation = {
    trackedLoadScopes: jest.fn(async () => ['t1:Ticket']),
  };
  const recordLoad = {
    reconcileTrackedScope: jest.fn(async () => ({
      candidates: 3,
      drifted: 1,
      absoluteDrift: 2,
    })),
  };
  const redis = {
    set: jest.fn(async () => 'OK'),
    eval: jest.fn(async () => 1),
  };
  const metrics = {
    setGauge: jest.fn(),
    incrementCounter: jest.fn(),
  };

  beforeEach(() => jest.clearAllMocks());

  it('should reconcile tracked record scopes and record drift metrics', async () => {
    const service = new RecordWorkloadReconciliationService(
      reservation as any,
      recordLoad as any,
      redis as any,
      metrics as any,
    );
    await service.reconcileAllTrackedScopes();

    expect(recordLoad.reconcileTrackedScope).toHaveBeenCalledWith({
      tenantId: 't1',
      objectType: 'Ticket',
    });
    expect(metrics.setGauge).toHaveBeenCalledWith(
      'crm_assignment_workload_absolute_drift',
      { object_type: 'Ticket' },
      2,
    );
    expect(redis.eval).toHaveBeenCalled();
  });

  it('should do nothing when another pod owns the lock', async () => {
    redis.set.mockResolvedValueOnce(null as any);
    const service = new RecordWorkloadReconciliationService(
      reservation as any,
      recordLoad as any,
      redis as any,
      metrics as any,
    );
    await service.reconcileAllTrackedScopes();
    expect(reservation.trackedLoadScopes).not.toHaveBeenCalled();
  });
});
