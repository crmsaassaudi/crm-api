import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { AgentFallbackService } from './agent-fallback.service';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { OMNI_FALLBACK_QUEUE } from '../queue/omni-fallback-queue.constants';
import { createQueueMock } from '../../test/mocks/queue.mock';

/**
 * AgentFallbackService — SCHEDULING only.
 *
 * This suite was rewritten. It previously drove `jest.useFakeTimers()` and
 * asserted that conversations were reassigned after the delay elapsed, because
 * the service used to hold an in-process `setTimeout`. That design could not
 * survive a restart — a rolling deploy silently dropped every pending
 * reassignment — so the work moved into a delayed BullMQ job.
 *
 * The consequence for tests: this class no longer reassigns anything. It decides
 * *whether* and *when*, and enqueues. Every assertion about strategy mapping,
 * presence re-checks and conversation updates now lives in
 * `fallback-reassign.processor.spec.ts`, where that logic actually runs — none of
 * the original intent was dropped, it was relocated.
 */
describe('AgentFallbackService', () => {
  let service: AgentFallbackService;
  let settingsServiceMock: { getSetting: jest.Mock };
  let redisMock: {
    set: jest.Mock;
    get: jest.Mock;
    del: jest.Mock;
    scan: jest.Mock;
  };
  let queueMock: ReturnType<typeof createQueueMock>;

  const TENANT = 'tenant_1';
  const AGENT = '507f1f77bcf86cd799439011';
  const JOB_ID = `fallback-${TENANT}-${AGENT}`;

  beforeEach(async () => {
    settingsServiceMock = {
      getSetting: jest.fn().mockResolvedValue({
        enabled: true,
        timeoutMinutes: 3,
        strategy: 'back-to-queue',
        notifyAgent: true,
      }),
    };

    redisMock = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(new Date().toISOString()),
      del: jest.fn().mockResolvedValue(1),
      // SCAN returns [cursor, keys]; '0' terminates the loop.
      scan: jest.fn().mockResolvedValue(['0', []]),
    };

    queueMock = createQueueMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentFallbackService,
        { provide: CrmSettingsService, useValue: settingsServiceMock },
        { provide: IOREDIS_CLIENT, useValue: redisMock },
        { provide: getQueueToken(OMNI_FALLBACK_QUEUE), useValue: queueMock },
      ],
    }).compile();

    service = module.get<AgentFallbackService>(AgentFallbackService);
  });

  describe('onAgentDisconnected — reads config from settings', () => {
    it('should read the auto-reassignment setting for the tenant', async () => {
      await service.onAgentDisconnected(TENANT, AGENT);

      expect(settingsServiceMock.getSetting).toHaveBeenCalledWith(
        'omni_auto_reassignment',
        TENANT,
      );
    });

    it('should schedule NOTHING when the feature is disabled', async () => {
      settingsServiceMock.getSetting.mockResolvedValue({ enabled: false });

      await service.onAgentDisconnected(TENANT, AGENT);

      expect(queueMock.add).not.toHaveBeenCalled();
      expect(redisMock.set).not.toHaveBeenCalled();
    });

    it('should use the custom timeout as the job delay', async () => {
      settingsServiceMock.getSetting.mockResolvedValue({
        enabled: true,
        timeoutMinutes: 10,
        strategy: 'next-available',
        notifyAgent: false,
      });

      await service.onAgentDisconnected(TENANT, AGENT);

      expect(queueMock.add).toHaveBeenCalledWith(
        'fallback-reassign',
        expect.objectContaining({ tenantId: TENANT, agentId: AGENT }),
        expect.objectContaining({ delay: 10 * 60 * 1000 }),
      );
    });

    it('should fail CLOSED when the settings read throws', async () => {
      // The previous version of this test expected a default of "enabled with a
      // 3-minute timeout". Defaulting to enabled means an unreadable config
      // causes conversations to be taken away from an agent on a guess. Not
      // scheduling is the safe direction: nothing moves, and the agent keeps
      // their queue until the config can be read.
      settingsServiceMock.getSetting.mockRejectedValue(new Error('DB down'));

      await service.onAgentDisconnected(TENANT, AGENT);

      expect(queueMock.add).not.toHaveBeenCalled();
      expect(redisMock.set).not.toHaveBeenCalled();
    });
  });

  describe('onAgentDisconnected — the enqueue contract', () => {
    it('should record the disconnect marker with a TTL that outlives the delay', async () => {
      // The processor reads this marker to confirm the agent is still gone. If it
      // expired first the job would find nothing and skip, so the buffer is what
      // makes the check meaningful rather than a race.
      await service.onAgentDisconnected(TENANT, AGENT);

      expect(redisMock.set).toHaveBeenCalledWith(
        `omni:agent:disconnected:${TENANT}:${AGENT}`,
        expect.any(String),
        'EX',
        3 * 60 + 60,
      );
    });

    it('should carry the strategy and notify flag into the job payload', async () => {
      // Resolved at schedule time and passed along, so the processor does not
      // re-read settings for the strategy.
      await service.onAgentDisconnected(TENANT, AGENT);

      expect(queueMock.add).toHaveBeenCalledWith(
        'fallback-reassign',
        expect.objectContaining({
          tenantId: TENANT,
          agentId: AGENT,
          strategy: 'back-to-queue',
          notifyAgent: true,
          disconnectTime: expect.any(String),
        }),
        expect.objectContaining({ jobId: JOB_ID, delay: 3 * 60 * 1000 }),
      );
    });

    it('should use a DETERMINISTIC job id per tenant+agent', async () => {
      // This is what makes rapid disconnect/reconnect/disconnect idempotent: the
      // new job replaces the old one instead of stacking a second reassignment.
      await service.onAgentDisconnected(TENANT, AGENT);
      const [, , options] = queueMock.add.mock.calls[0];
      expect(options.jobId).toBe(JOB_ID);
    });

    it('should remove a pending job before scheduling a replacement', async () => {
      const remove = jest.fn().mockResolvedValue(undefined);
      queueMock.getJob.mockResolvedValue({ remove });

      await service.onAgentDisconnected(TENANT, AGENT);

      expect(queueMock.getJob).toHaveBeenCalledWith(JOB_ID);
      expect(remove).toHaveBeenCalled();
      expect(queueMock.add).toHaveBeenCalled();
    });

    it('should still schedule when removing the old job throws', async () => {
      // The job may have already completed or been trimmed. Failing to remove a
      // job that is not there must not prevent scheduling the new one.
      queueMock.getJob.mockRejectedValue(new Error('connection reset'));

      await service.onAgentDisconnected(TENANT, AGENT);

      expect(queueMock.add).toHaveBeenCalled();
    });
  });

  describe('onAgentReconnected', () => {
    it('should cancel the pending job and clear the marker', async () => {
      const remove = jest.fn().mockResolvedValue(undefined);
      queueMock.getJob.mockResolvedValue({ remove });

      await service.onAgentReconnected(TENANT, AGENT);

      expect(queueMock.getJob).toHaveBeenCalledWith(JOB_ID);
      expect(remove).toHaveBeenCalled();
      expect(redisMock.del).toHaveBeenCalledWith(
        `omni:agent:disconnected:${TENANT}:${AGENT}`,
      );
    });

    it('should clear the marker even when there is no job to cancel', async () => {
      // Belt and braces: the marker is the processor's authority on "still
      // offline", so a stale one left behind would let a later job reassign an
      // agent who is present.
      queueMock.getJob.mockResolvedValue(null);

      await service.onAgentReconnected(TENANT, AGENT);

      expect(redisMock.del).toHaveBeenCalled();
    });
  });

  describe('onSettingsChanged', () => {
    const disconnectKey = `omni:agent:disconnected:${TENANT}:${AGENT}`;

    it('should IGNORE unrelated setting keys', async () => {
      await service.onSettingsChanged({
        key: 'omni_business_hours',
        tenantId: TENANT,
      });

      expect(redisMock.scan).not.toHaveBeenCalled();
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('should do nothing when no agents are disconnected', async () => {
      redisMock.scan.mockResolvedValue(['0', []]);

      await service.onSettingsChanged({
        key: 'omni_auto_reassignment',
        tenantId: TENANT,
      });

      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('should CANCEL pending jobs when the feature is switched off', async () => {
      // Without this, turning the feature off leaves already-scheduled jobs to
      // fire minutes later — the setting appears to do nothing.
      redisMock.scan.mockResolvedValue(['0', [disconnectKey]]);
      settingsServiceMock.getSetting.mockResolvedValue({ enabled: false });
      const remove = jest.fn().mockResolvedValue(undefined);
      queueMock.getJob.mockResolvedValue({ remove });

      await service.onSettingsChanged({
        key: 'omni_auto_reassignment',
        tenantId: TENANT,
      });

      expect(remove).toHaveBeenCalled();
      expect(redisMock.del).toHaveBeenCalledWith(disconnectKey);
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('should RESCHEDULE with the elapsed time deducted from the new timeout', async () => {
      // An agent who has already been gone 4 minutes must not get a fresh full
      // 10-minute reprieve when the timeout is raised.
      const fourMinutesAgo = new Date(Date.now() - 4 * 60 * 1000).toISOString();
      redisMock.scan.mockResolvedValue(['0', [disconnectKey]]);
      redisMock.get.mockResolvedValue(fourMinutesAgo);
      settingsServiceMock.getSetting.mockResolvedValue({
        enabled: true,
        timeoutMinutes: 10,
        strategy: 'next-available',
        notifyAgent: true,
      });

      await service.onSettingsChanged({
        key: 'omni_auto_reassignment',
        tenantId: TENANT,
      });

      const [, , options] = queueMock.add.mock.calls[0];
      // ~6 minutes remain; allow a second of slack for clock movement in-test.
      expect(options.delay).toBeGreaterThan(5 * 60 * 1000 + 55 * 1000);
      expect(options.delay).toBeLessThanOrEqual(6 * 60 * 1000);
    });

    it('should CLAMP the delay to zero when the new timeout has already passed', async () => {
      // Lowering the timeout below the elapsed time must fire immediately, not
      // compute a negative delay that BullMQ would reject or treat as no delay
      // in a surprising way.
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      redisMock.scan.mockResolvedValue(['0', [disconnectKey]]);
      redisMock.get.mockResolvedValue(hourAgo);
      settingsServiceMock.getSetting.mockResolvedValue({
        enabled: true,
        timeoutMinutes: 1,
        strategy: 'back-to-queue',
        notifyAgent: true,
      });

      await service.onSettingsChanged({
        key: 'omni_auto_reassignment',
        tenantId: TENANT,
      });

      const [, , options] = queueMock.add.mock.calls[0];
      expect(options.delay).toBe(0);
    });

    it('should SKIP a marker whose value vanished mid-scan', async () => {
      // The key can expire between SCAN and GET. Rescheduling from a missing
      // disconnect time would mean guessing when the agent went offline.
      redisMock.scan.mockResolvedValue(['0', [disconnectKey]]);
      redisMock.get.mockResolvedValue(null);
      settingsServiceMock.getSetting.mockResolvedValue({
        enabled: true,
        timeoutMinutes: 5,
        strategy: 'back-to-queue',
        notifyAgent: true,
      });

      await service.onSettingsChanged({
        key: 'omni_auto_reassignment',
        tenantId: TENANT,
      });

      expect(queueMock.add).not.toHaveBeenCalled();
    });
  });
});
