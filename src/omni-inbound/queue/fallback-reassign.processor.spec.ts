import { Job } from 'bullmq';
import {
  FallbackReassignJobData,
  FallbackReassignProcessor,
} from './fallback-reassign.processor';

/**
 * FallbackReassignProcessor — where agent-fallback reassignment actually happens.
 *
 * This file is new. The behaviour it covers used to be tested in
 * `agent-fallback.service.spec.ts` against an in-process `setTimeout`; when that
 * moved to a delayed BullMQ job the assertions were left behind on a class that
 * no longer does the work, so they failed and — more importantly — the code that
 * DOES the work had no coverage at all. The strategy mapping, the presence
 * re-check and the skip conditions are reproduced here rather than deleted.
 *
 * The guards deserve the emphasis they get below: this job runs minutes after it
 * was scheduled, so the world it was scheduled in may be gone. Every early
 * return is a case where reassigning would take conversations away from an agent
 * who is present and working.
 */
describe('FallbackReassignProcessor', () => {
  let processor: FallbackReassignProcessor;
  let assignmentService: { assignConversation: jest.Mock };
  let presenceService: {
    getPresence: jest.Mock;
    releaseConversation: jest.Mock;
  };
  let conversationRepo: { findOpenByAgent: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let settingsService: { getSetting: jest.Mock };
  let redis: { get: jest.Mock; del: jest.Mock };
  let conversationCommandService: { enqueueAssignAgent: jest.Mock };
  let cls: { get: jest.Mock; set: jest.Mock; run: jest.Mock };

  const TENANT = 'tenant_1';
  const AGENT = '507f1f77bcf86cd799439011';
  const MARKER = `omni:agent:disconnected:${TENANT}:${AGENT}`;

  const job = (
    overrides: Partial<FallbackReassignJobData> = {},
  ): Job<FallbackReassignJobData> =>
    ({
      id: 'job_1',
      name: 'fallback-reassign',
      data: {
        tenantId: TENANT,
        agentId: AGENT,
        strategy: 'back-to-queue',
        notifyAgent: true,
        ...overrides,
      },
    }) as Job<FallbackReassignJobData>;

  /** `handle` is protected; the queue calls it, so tests do too. */
  const run = (j = job()) => (processor as any).handle(j);

  beforeEach(() => {
    assignmentService = {
      assignConversation: jest.fn().mockResolvedValue('new_agent_1'),
    };
    presenceService = {
      getPresence: jest.fn().mockResolvedValue(null), // offline
      releaseConversation: jest.fn().mockResolvedValue(undefined),
    };
    conversationRepo = {
      findOpenByAgent: jest.fn().mockResolvedValue([]),
    };
    eventEmitter = { emit: jest.fn() };
    settingsService = {
      getSetting: jest.fn().mockResolvedValue({ enabled: true }),
    };
    redis = {
      get: jest.fn().mockResolvedValue(new Date().toISOString()),
      del: jest.fn().mockResolvedValue(1),
    };
    conversationCommandService = {
      enqueueAssignAgent: jest.fn().mockResolvedValue(undefined),
    };
    cls = { get: jest.fn(), set: jest.fn(), run: jest.fn() };

    processor = new FallbackReassignProcessor(
      assignmentService as any,
      presenceService as any,
      conversationRepo as any,
      eventEmitter as any,
      settingsService as any,
      redis as any,
      conversationCommandService as any,
      cls as any,
    );
  });

  describe('guards — every one prevents taking work from a present agent', () => {
    it('should SKIP an agentId that is not a valid ObjectId', async () => {
      // `findOpenByAgent` queries assignedAgentId. A non-ObjectId would make
      // Mongo throw, and a retrying job would throw forever.
      await run(job({ agentId: 'not-a-valid-objectid' }));

      expect(conversationRepo.findOpenByAgent).not.toHaveBeenCalled();
      expect(redis.get).not.toHaveBeenCalled();
    });

    it('should SKIP when the agent reconnected before the job fired', async () => {
      // The marker is deleted on reconnect, so its absence is the signal.
      redis.get.mockResolvedValue(null);

      await run();

      expect(conversationRepo.findOpenByAgent).not.toHaveBeenCalled();
      expect(assignmentService.assignConversation).not.toHaveBeenCalled();
    });

    it('should ABORT when the feature was disabled during the delay', async () => {
      // The job was scheduled while the feature was on. Checking again here is
      // what makes switching it off take effect for jobs already in flight.
      settingsService.getSetting.mockResolvedValue({ enabled: false });

      await run();

      expect(conversationRepo.findOpenByAgent).not.toHaveBeenCalled();
      expect(redis.del).toHaveBeenCalledWith(MARKER);
    });

    it('should PROCEED when the settings read throws', async () => {
      // Deliberately the opposite direction from the scheduler's fail-closed
      // read. By this point the tenant has already opted in and the job exists;
      // abandoning it on a transient settings error would leave the
      // conversations stranded with an offline agent, which is the harm the
      // feature exists to prevent.
      settingsService.getSetting.mockRejectedValue(new Error('DB down'));
      conversationRepo.findOpenByAgent.mockResolvedValue([{ id: 'conv_1' }]);

      await run();

      expect(conversationRepo.findOpenByAgent).toHaveBeenCalled();
    });

    it('should SKIP when presence shows the agent is active', async () => {
      // A second, independent check: the socket may have reconnected without the
      // marker being cleared.
      presenceService.getPresence.mockResolvedValue({ status: 'online' });

      await run();

      expect(conversationRepo.findOpenByAgent).not.toHaveBeenCalled();
      expect(redis.del).toHaveBeenCalledWith(MARKER);
    });

    it('should clean up and stop when the agent has no open conversations', async () => {
      conversationRepo.findOpenByAgent.mockResolvedValue([]);

      await run();

      expect(assignmentService.assignConversation).not.toHaveBeenCalled();
      expect(
        conversationCommandService.enqueueAssignAgent,
      ).not.toHaveBeenCalled();
      expect(redis.del).toHaveBeenCalledWith(MARKER);
    });
  });

  describe('strategy mapping', () => {
    beforeEach(() => {
      conversationRepo.findOpenByAgent.mockResolvedValue([{ id: 'conv_1' }]);
    });

    it('should map "back-to-queue" to an UNASSIGN command, not a reassignment', async () => {
      await run(job({ strategy: 'back-to-queue' }));

      expect(
        conversationCommandService.enqueueAssignAgent,
      ).toHaveBeenCalledWith(
        'conv_1',
        TENANT,
        expect.objectContaining({
          agentId: null,
          previousAgentId: AGENT,
          reason: 'fallback_offline',
        }),
      );
      expect(assignmentService.assignConversation).not.toHaveBeenCalled();
    });

    it('should map "next-available" to round-robin assignment', async () => {
      await run(job({ strategy: 'next-available' }));

      expect(assignmentService.assignConversation).toHaveBeenCalledWith(
        TENANT,
        'conv_1',
        { strategy: 'round-robin', allowReassignment: true },
      );
      expect(
        conversationCommandService.enqueueAssignAgent,
      ).not.toHaveBeenCalled();
    });

    it('should map "supervisor" to manual assignment', async () => {
      await run(job({ strategy: 'supervisor' }));

      expect(assignmentService.assignConversation).toHaveBeenCalledWith(
        TENANT,
        'conv_1',
        { strategy: 'manual', allowReassignment: true },
      );
    });

    it('should fall back to round-robin for an unknown strategy', async () => {
      // A strategy string stored by an older version, or hand-edited. Doing
      // nothing would strand the conversations; round-robin is the safe default.
      await run(job({ strategy: 'whatever-this-is' }));

      expect(assignmentService.assignConversation).toHaveBeenCalledWith(
        TENANT,
        'conv_1',
        { strategy: 'round-robin', allowReassignment: true },
      );
    });
  });

  describe('reassignment', () => {
    it('should process every open conversation', async () => {
      conversationRepo.findOpenByAgent.mockResolvedValue([
        { id: 'conv_1' },
        { id: 'conv_2' },
        { id: 'conv_3' },
      ]);

      await run(job({ strategy: 'next-available' }));

      expect(assignmentService.assignConversation).toHaveBeenCalledTimes(3);
    });

    it('should RELEASE the offline agent Redis capacity per conversation (F-02)', async () => {
      // A documented past bug: the counter stayed inflated after unassignment, so
      // on reconnect the agent was stuck in 'full' routing status with zero real
      // conversations and received nothing.
      conversationRepo.findOpenByAgent.mockResolvedValue([
        { id: 'conv_1' },
        { id: 'conv_2' },
      ]);

      await run();

      expect(presenceService.releaseConversation).toHaveBeenCalledTimes(2);
      expect(presenceService.releaseConversation).toHaveBeenCalledWith(
        TENANT,
        AGENT,
      );
    });

    it('should emit an assignment event carrying the OLD agent', async () => {
      // The realtime layer needs the previous holder to remove the conversation
      // from their inbox, not merely to add it to someone else's.
      conversationRepo.findOpenByAgent.mockResolvedValue([{ id: 'conv_1' }]);

      await run(job({ strategy: 'next-available' }));

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'omni.conversation.assigned',
        expect.objectContaining({
          tenantId: TENANT,
          conversationId: 'conv_1',
          agentId: 'new_agent_1',
          oldAgentId: AGENT,
          reason: 'agent_offline_reassignment',
        }),
      );
    });

    it('should CONTINUE after one conversation fails', async () => {
      // One locked or deleted conversation must not abandon the rest. The job
      // gets one chance at its delay, so a thrown error here would leave the
      // remaining conversations with an offline agent indefinitely.
      conversationRepo.findOpenByAgent.mockResolvedValue([
        { id: 'conv_1' },
        { id: 'conv_2' },
      ]);
      assignmentService.assignConversation
        .mockRejectedValueOnce(new Error('conversation locked'))
        .mockResolvedValueOnce('new_agent_2');

      await expect(
        run(job({ strategy: 'next-available' })),
      ).resolves.toBeUndefined();

      expect(assignmentService.assignConversation).toHaveBeenCalledTimes(2);
      // Still cleaned up, so a retry does not re-run the whole batch.
      expect(redis.del).toHaveBeenCalledWith(MARKER);
    });

    it('should clear the disconnect marker when done', async () => {
      conversationRepo.findOpenByAgent.mockResolvedValue([{ id: 'conv_1' }]);

      await run();

      expect(redis.del).toHaveBeenCalledWith(MARKER);
    });
  });
});
