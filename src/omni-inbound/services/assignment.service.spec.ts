/* eslint-disable @typescript-eslint/require-await -- mock factories model async
   collaborators; an await inside them would be noise. */
import {
  AssignmentService,
  channelOverrideToConfigOverride,
} from './assignment.service';
import { mergeAssignmentConfig } from '../../assignment/core/assignment-config.service';
import { AssignDecision } from '../../assignment/core/assignment-core.service';

/**
 * The routing pipeline itself is tested in
 * `assignment/core/assignment-core.service.spec.ts`. What is left to verify here
 * is the conversation-specific half: the channel-override translation, the
 * preferred-agent lookup, and how each outcome is turned into a side effect.
 */

function buildService(overrides?: {
  config?: Partial<Record<string, unknown>>;
  decision?: Partial<AssignDecision>;
  conversation?: Record<string, unknown> | null;
  lastResolvedByContact?: Record<string, unknown> | null;
  lastResolvedBySender?: Record<string, unknown> | null;
  cached?: string | null;
}) {
  const decision: AssignDecision = {
    outcome: 'assigned',
    assigneeId: 'agent-1',
    groupId: null,
    strategy: 'round-robin',
    reasonKey: 'assigned',
    reason: 'ok',
    rule: null,
    candidatePoolSize: 2,
    eligiblePoolSize: 2,
    ...overrides?.decision,
  };

  const core = {
    // Typed with a parameter so assertions can read mock.calls[n][0].
    assign: jest.fn(async (_request: any) => decision),
    registerAdapter: jest.fn(),
    recordExternalDecision: jest.fn(async (_entry: any) => undefined),
  };

  const config = {
    resolve: jest.fn(async (_t: string, _o: string, override?: any) =>
      mergeAssignmentConfig(overrides?.config as any, override),
    ),
    get: jest.fn(async () =>
      mergeAssignmentConfig(overrides?.config as any, null),
    ),
    invalidate: jest.fn(async () => undefined),
  };

  const load = { release: jest.fn(async () => undefined) };
  const adapter = { objectTypes: ['Conversation'], load };
  const commitPort = {
    reassign: jest.fn(async () => true),
    commit: jest.fn(async () => true),
    park: jest.fn(async () => undefined),
  };
  const candidatePort = { groupMembers: jest.fn(async () => ['m1', 'm2']) };
  const recordCandidatePort = { setPresenceProvider: jest.fn() };
  const presenceService = { getAllAgents: jest.fn(async () => []) };

  const conversationRepo = {
    findById: jest.fn(async () =>
      overrides?.conversation === undefined
        ? { id: 'c1', channelId: 'ch1', assignedAgentId: null }
        : overrides.conversation,
    ),
    findLastResolvedByContact: jest.fn(
      async () => overrides?.lastResolvedByContact ?? null,
    ),
    findLastResolvedBySender: jest.fn(
      async () => overrides?.lastResolvedBySender ?? null,
    ),
  };

  const channelSupport = {
    assertAgentEligible: jest.fn(async () => undefined),
    assertGroupEligible: jest.fn(async () => undefined),
  };

  const eventEmitter = { emit: jest.fn() };
  const redis = {
    get: jest.fn(async () => overrides?.cached ?? null),
    set: jest.fn(async () => 'OK'),
  };
  const stickyQueue = { add: jest.fn(async () => ({ id: 'j1' })) };

  const service = new AssignmentService(
    core as any,
    config as any,
    adapter as any,
    commitPort as any,
    candidatePort as any,
    recordCandidatePort as any,
    presenceService as any,
    conversationRepo as any,
    channelSupport as any,
    eventEmitter as any,
    redis as any,
    stickyQueue as any,
  );

  return {
    service,
    core,
    config,
    load,
    commitPort,
    candidatePort,
    recordCandidatePort,
    conversationRepo,
    channelSupport,
    eventEmitter,
    redis,
    stickyQueue,
  };
}

describe('channelOverrideToConfigOverride', () => {
  it('should return null when the channel sets nothing', () => {
    expect(channelOverrideToConfigOverride(undefined)).toBeNull();
    expect(channelOverrideToConfigOverride(null)).toBeNull();
  });

  it('should translate the channel vocabulary onto the core vocabulary', () => {
    expect(
      channelOverrideToConfigOverride({
        stickyRoutingDefault: true,
        stickyTimeoutHours: 24,
        stickyWaitTimeMinutes: 5,
      }),
    ).toEqual({
      preferPreviousAssignee: true,
      previousAssigneeTimeoutHours: 24,
      previousAssigneeWaitMinutes: 5,
    });
  });

  it('should leave unset fields undefined so they inherit per field', () => {
    const result = channelOverrideToConfigOverride({
      defaultStrategy: 'least_busy',
    });
    expect(result).toEqual({ defaultStrategy: 'least-busy' });
    // Not `defaultMaxCapacity: undefined` — the key must be absent so the merge
    // falls through to the stored value rather than the hard default.
    expect(Object.keys(result ?? {})).toEqual(['defaultStrategy']);
  });

  it('should normalise legacy snake_case strategies', () => {
    expect(
      channelOverrideToConfigOverride({
        stickyFallbackStrategy: 'capacity_based',
      }),
    ).toEqual({ stickyFallbackStrategy: 'capacity-based' });
  });

  it('should preserve an explicit false rather than dropping it', () => {
    expect(
      channelOverrideToConfigOverride({ skillBasedRoutingEnabled: false }),
    ).toEqual({ skillBasedRoutingEnabled: false });
  });
});

describe('AssignmentService', () => {
  describe('registration', () => {
    it('should register the conversation adapter with the core on init', () => {
      const h = buildService();
      h.service.onModuleInit();
      expect(h.core.registerAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ objectTypes: ['Conversation'] }),
      );
    });
  });

  describe('assignConversation', () => {
    it('should pass the channel id as the scope so the support pool applies', async () => {
      const h = buildService();
      await h.service.assignConversation('t1', 'c1', { channelId: 'ch9' });
      expect(h.core.assign).toHaveBeenCalledWith(
        expect.objectContaining({
          objectType: 'Conversation',
          entityId: 'c1',
          scopeId: 'ch9',
        }),
      );
    });

    it('should accept the legacy positional strategy form', async () => {
      const h = buildService();
      await h.service.assignConversation('t1', 'c1', 'least-busy');
      expect(h.core.assign).toHaveBeenCalledWith(
        expect.objectContaining({ strategy: 'least-busy' }),
      );
    });

    it('should forward an explicit agent pool as an extra restriction', async () => {
      const h = buildService();
      await h.service.assignConversation('t1', 'c1', {
        agentPool: ['a', 'b'],
      });
      expect(h.core.assign).toHaveBeenCalledWith(
        expect.objectContaining({ restrictToCandidates: ['a', 'b'] }),
      );
    });

    it('should flatten the routing context into rule-condition field names', async () => {
      const h = buildService();
      await h.service.assignConversation('t1', 'c1', {
        routingContext: {
          channel: 'facebook',
          channelId: 'ch1',
          tags: ['VIP'],
          businessHours: 'outside',
        },
      });
      const request = h.core.assign.mock.calls[0][0] as any;
      expect(request.attributes).toMatchObject({
        channel: 'facebook',
        channel_id: 'ch1',
        tag: ['VIP'],
        business_hours: 'outside',
      });
    });

    it('should let a channel that explicitly enabled auto-assign override the setting', async () => {
      const h = buildService({ config: { autoAssignEnabled: false } });
      await h.service.assignConversation('t1', 'c1', {
        channelAutoAssignOverride: true,
      });
      const request = h.core.assign.mock.calls[0][0] as any;
      expect(request.configOverride).toMatchObject({ autoAssignEnabled: true });
    });

    it('should supply an unconditional commit only when reassignment is allowed', async () => {
      const plain = buildService();
      await plain.service.assignConversation('t1', 'c1', {});
      expect(
        (plain.core.assign.mock.calls[0][0] as any).commit,
      ).toBeUndefined();

      const reassign = buildService();
      await reassign.service.assignConversation('t1', 'c1', {
        allowReassignment: true,
      });
      const request = reassign.core.assign.mock.calls[0][0] as any;
      expect(typeof request.commit).toBe('function');
      await request.commit('agent-9', 'g1');
      expect(reassign.commitPort.reassign).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'c1' }),
        'agent-9',
        'g1',
      );
    });
  });

  describe('preferred-agent lookup', () => {
    const enabled = { autoAssignEnabled: true, preferPreviousAssignee: true };

    it('should be skipped when the preference is disabled', async () => {
      const h = buildService();
      await h.service.assignConversation('t1', 'c1', { contactId: 'k1' });
      expect((h.core.assign.mock.calls[0][0] as any).preferred).toBeNull();
      expect(
        h.conversationRepo.findLastResolvedByContact,
      ).not.toHaveBeenCalled();
    });

    it('should be skipped when the caller asks to skip it', async () => {
      const h = buildService({ config: enabled });
      await h.service.assignConversation('t1', 'c1', {
        contactId: 'k1',
        skipSticky: true,
      });
      expect((h.core.assign.mock.calls[0][0] as any).preferred).toBeNull();
    });

    it('should read the Redis cache before touching MongoDB', async () => {
      const h = buildService({
        config: enabled,
        cached: JSON.stringify({
          agentId: 'agent-7',
          resolvedAt: new Date().toISOString(),
        }),
      });
      await h.service.assignConversation('t1', 'c1', { contactId: 'k1' });
      expect((h.core.assign.mock.calls[0][0] as any).preferred).toMatchObject({
        assigneeId: 'agent-7',
        source: 'contactId:cache',
      });
      expect(
        h.conversationRepo.findLastResolvedByContact,
      ).not.toHaveBeenCalled();
    });

    it('should fall back to MongoDB on a cache miss', async () => {
      const h = buildService({
        config: enabled,
        lastResolvedByContact: {
          assignedAgentId: 'agent-3',
          resolvedAt: new Date(),
        },
      });
      await h.service.assignConversation('t1', 'c1', { contactId: 'k1' });
      expect((h.core.assign.mock.calls[0][0] as any).preferred).toMatchObject({
        assigneeId: 'agent-3',
        source: 'contactId',
      });
    });

    it('should ignore an agent whose last contact is older than the timeout', async () => {
      const h = buildService({
        config: { ...enabled, previousAssigneeTimeoutHours: 1 },
        lastResolvedByContact: {
          assignedAgentId: 'agent-3',
          resolvedAt: new Date(Date.now() - 5 * 3_600_000),
        },
      });
      await h.service.assignConversation('t1', 'c1', { contactId: 'k1' });
      expect((h.core.assign.mock.calls[0][0] as any).preferred).toBeNull();
    });

    it('should fall back to the sender id when there is no contact match', async () => {
      const h = buildService({
        config: enabled,
        lastResolvedBySender: {
          assignedAgentId: 'agent-4',
          updatedAt: new Date(),
        },
      });
      await h.service.assignConversation('t1', 'c1', {
        contactId: 'k1',
        externalSenderId: 'psid-1',
      });
      expect((h.core.assign.mock.calls[0][0] as any).preferred).toMatchObject({
        assigneeId: 'agent-4',
        source: 'externalSenderId',
      });
    });

    it('should ask the core to wait only when a wait window is configured', async () => {
      const waiting = buildService({
        config: { ...enabled, previousAssigneeWaitMinutes: 3 },
        cached: JSON.stringify({
          agentId: 'agent-7',
          resolvedAt: new Date().toISOString(),
        }),
      });
      await waiting.service.assignConversation('t1', 'c1', { contactId: 'k1' });
      expect(
        (waiting.core.assign.mock.calls[0][0] as any).preferred.onBusy,
      ).toBe('wait');

      const immediate = buildService({
        config: { ...enabled, previousAssigneeWaitMinutes: 0 },
        cached: JSON.stringify({
          agentId: 'agent-7',
          resolvedAt: new Date().toISOString(),
        }),
      });
      await immediate.service.assignConversation('t1', 'c1', {
        contactId: 'k1',
      });
      expect(
        (immediate.core.assign.mock.calls[0][0] as any).preferred.onBusy,
      ).toBe('fall-through');
    });
  });

  describe('outcome side effects', () => {
    it('should schedule one idempotent retry job for a deferred decision', async () => {
      const h = buildService({
        decision: {
          outcome: 'deferred',
          assigneeId: null,
          deferred: { assigneeId: 'agent-2', waitMinutes: 4 },
        },
      });
      const result = await h.service.assignConversation('t1', 'c1', {});
      expect(result).toBeNull();
      expect(h.stickyQueue.add).toHaveBeenCalledWith(
        'sticky-retry',
        expect.objectContaining({
          conversationId: 'c1',
          stickyAgentId: 'agent-2',
        }),
        expect.objectContaining({
          jobId: 'sticky-retry-c1',
          delay: 4 * 60_000,
        }),
      );
      expect(h.eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should emit the queued event so the inbox can show the backlog', async () => {
      const h = buildService({
        decision: {
          outcome: 'queued',
          assigneeId: null,
          reason: 'nobody online',
          candidatePoolSize: 4,
        },
      });
      await h.service.assignConversation('t1', 'c1', {
        routingContext: { channel: 'zalo' },
      });
      expect(h.eventEmitter.emit).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          conversationId: 'c1',
          channelType: 'zalo',
          agentPoolSize: 4,
        }),
      );
    });

    it('should emit nothing for an assigned decision', async () => {
      const h = buildService();
      const result = await h.service.assignConversation('t1', 'c1', {});
      expect(result).toBe('agent-1');
      expect(h.eventEmitter.emit).not.toHaveBeenCalled();
      expect(h.stickyQueue.add).not.toHaveBeenCalled();
    });

    it('should survive a failed retry schedule without throwing', async () => {
      const h = buildService({
        decision: {
          outcome: 'deferred',
          assigneeId: null,
          deferred: { assigneeId: 'agent-2', waitMinutes: 4 },
        },
      });
      h.stickyQueue.add.mockRejectedValueOnce(new Error('redis down'));
      await expect(
        h.service.assignConversation('t1', 'c1', {}),
      ).resolves.toBeNull();
    });
  });

  describe('assignConversationExternally', () => {
    it('should check the channel pool before a direct agent assignment', async () => {
      const h = buildService();
      await h.service.assignConversationExternally(
        't1',
        'c1',
        { agentId: 'agent-5' },
        'automation:w1',
      );
      expect(h.channelSupport.assertAgentEligible).toHaveBeenCalledWith(
        't1',
        'ch1',
        'agent-5',
      );
      expect(h.core.assign).toHaveBeenCalledWith(
        expect.objectContaining({ manualAssigneeId: 'agent-5' }),
      );
    });

    it('should hand the previous agent capacity slot back', async () => {
      const h = buildService({
        conversation: {
          id: 'c1',
          channelId: 'ch1',
          assignedAgentId: 'agent-old',
        },
      });
      await h.service.assignConversationExternally(
        't1',
        'c1',
        { agentId: 'agent-5' },
        'automation:w1',
      );
      expect(h.load.release).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'c1' }),
        'agent-old',
      );
    });

    it('should not release when the target is already the assigned agent', async () => {
      const h = buildService({
        conversation: {
          id: 'c1',
          channelId: 'ch1',
          assignedAgentId: 'agent-5',
        },
      });
      await h.service.assignConversationExternally(
        't1',
        'c1',
        { agentId: 'agent-5' },
        'automation:w1',
      );
      expect(h.load.release).not.toHaveBeenCalled();
    });

    it('should check the channel pool and skips rules for a group assignment', async () => {
      const h = buildService();
      const result = await h.service.assignConversationExternally(
        't1',
        'c1',
        { groupId: 'g1' },
        'automation:w1',
      );
      expect(h.channelSupport.assertGroupEligible).toHaveBeenCalledWith(
        't1',
        'ch1',
        'g1',
      );
      expect(h.core.assign).toHaveBeenCalledWith(
        expect.objectContaining({
          targetGroupIds: ['g1'],
          skipRules: true,
        }),
      );
      expect(result.groupId).toBe('g1');
    });

    it('should reject a target that names neither an agent nor a group', async () => {
      const h = buildService();
      await expect(
        h.service.assignConversationExternally('t1', 'c1', {}, 'automation:w1'),
      ).rejects.toThrow('requires agentId or groupId');
    });

    it('should throw when the conversation does not exist', async () => {
      const h = buildService({ conversation: null });
      await expect(
        h.service.assignConversationExternally(
          't1',
          'missing',
          { agentId: 'a' },
          'automation:w1',
        ),
      ).rejects.toThrow('not found');
    });
  });

  describe('audit for decisions the core did not make', () => {
    it('should distinguish assign, reassign and unassign', async () => {
      const h = buildService();

      await h.service.logManualAssignment({
        conversationId: 'c1',
        tenantId: 't1',
        newAgentId: 'a1',
        previousAgentId: null,
        performedByUserId: 'u1',
      });
      expect(h.core.recordExternalDecision).toHaveBeenLastCalledWith(
        expect.objectContaining({
          reasonKey: 'manualAssigned',
          outcome: 'assigned',
        }),
      );

      await h.service.logManualAssignment({
        conversationId: 'c1',
        tenantId: 't1',
        newAgentId: 'a2',
        previousAgentId: 'a1',
        performedByUserId: 'u1',
      });
      expect(h.core.recordExternalDecision).toHaveBeenLastCalledWith(
        expect.objectContaining({ reasonKey: 'manualReassigned' }),
      );

      await h.service.logManualAssignment({
        conversationId: 'c1',
        tenantId: 't1',
        newAgentId: null,
        previousAgentId: 'a2',
        performedByUserId: 'u1',
      });
      expect(h.core.recordExternalDecision).toHaveBeenLastCalledWith(
        expect.objectContaining({
          reasonKey: 'manualUnassigned',
          outcome: 'queued',
        }),
      );
    });

    it('should record a reply-triggered assignment as its own source', async () => {
      const h = buildService();
      await h.service.logReplyAutoAssignment({
        conversationId: 'c1',
        tenantId: 't1',
        agentId: 'a1',
      });
      expect(h.core.recordExternalDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'reply',
          reasonKey: 'replyAutoAssign',
        }),
      );
    });
  });

  describe('sticky cache', () => {
    it('should cache the resolving agent under both identities with the timeout as TTL', async () => {
      const h = buildService({
        config: { previousAssigneeTimeoutHours: 2 },
        conversation: {
          id: 'c1',
          assignedAgentId: 'a1',
          contactId: 'k1',
          externalSenderId: 'psid-1',
          resolvedAt: new Date(),
        },
      });
      await h.service.handleConversationResolvedForSticky({
        tenantId: 't1',
        conversationId: 'c1',
        status: 'resolved',
      });
      expect(h.redis.set).toHaveBeenCalledTimes(2);
      expect(h.redis.set).toHaveBeenCalledWith(
        'omni:sticky:t1:c:k1',
        expect.any(String),
        'EX',
        7200,
      );
    });

    it('should ignore status changes that are not a close', async () => {
      const h = buildService();
      await h.service.handleConversationResolvedForSticky({
        tenantId: 't1',
        conversationId: 'c1',
        status: 'open',
      });
      expect(h.redis.set).not.toHaveBeenCalled();
    });

    it('should write nothing when the conversation had no agent', async () => {
      const h = buildService({
        conversation: { id: 'c1', assignedAgentId: null, contactId: 'k1' },
      });
      await h.service.handleConversationResolvedForSticky({
        tenantId: 't1',
        conversationId: 'c1',
        status: 'closed',
      });
      expect(h.redis.set).not.toHaveBeenCalled();
    });
  });

  describe('config invalidation', () => {
    it('should drop the cached Conversation config when omni_routing changes', async () => {
      const h = buildService();
      await h.service.handleSettingsChanged({
        key: 'omni_routing',
        tenantId: 't1',
      });
      expect(h.config.invalidate).toHaveBeenCalledWith('t1', 'Conversation');
    });

    it('should ignore unrelated settings keys', async () => {
      const h = buildService();
      await h.service.handleSettingsChanged({
        key: 'deal_pipeline',
        tenantId: 't1',
      });
      expect(h.config.invalidate).not.toHaveBeenCalled();
    });
  });
});
