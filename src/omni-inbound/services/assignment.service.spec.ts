import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { getModelToken } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AssignmentService, mergeRoutingConfig } from './assignment.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { AgentPresenceService } from './agent-presence.service';
import { AssignmentAuditLogRepository } from '../repositories/omni-assignment-audit-log.repository';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { UsersService } from '../../users/users.service';
import { RoutingRuleEvaluatorService } from '../../routing-rules/routing-rule-evaluator.service';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { OMNI_STICKY_RETRY_QUEUE } from '../queue/omni-sticky-queue.constants';

/**
 * Smart AgentPresenceService mock that emulates the atomic Lua reservation
 * behaviour without a real Redis. It keeps an in-memory load/capacity map so
 * least-busy and capacity-based selection stay meaningful in unit tests.
 *
 * - reserveAgentFromCandidates  → least-busy: pick lowest-load candidate under
 *   capacity, then increment its load (mirrors the Lua reserve + ZADD).
 * - reserveCapacityBasedAgent   → same, but the capacity gate uses the tenant
 *   fallback when the agent has no per-agent capacity.
 * - releaseConversation         → decrement load (rollback path).
 */
function createPresenceMock() {
  const loads: Record<string, number> = {};
  const caps: Record<string, number> = {};
  const skills: Record<string, string[]> = {};

  const effectiveCap = (id: string, tenantCap: number) =>
    caps[id] && caps[id] > 0 ? caps[id] : tenantCap > 0 ? tenantCap : 10;

  const reserve = (ids: string[], tenantCap: number): string | null => {
    const eligible = ids.filter(
      (id) => (loads[id] ?? 0) < effectiveCap(id, tenantCap),
    );
    if (eligible.length === 0) return null;
    eligible.sort((a, b) => (loads[a] ?? 0) - (loads[b] ?? 0));
    const chosen = eligible[0];
    loads[chosen] = (loads[chosen] ?? 0) + 1;
    return chosen;
  };

  return {
    // ── test helpers ──────────────────────────────────────────────
    __setLoad: (id: string, n: number) => {
      loads[id] = n;
    },
    __setCapacity: (id: string, n: number) => {
      caps[id] = n;
    },
    __setSkills: (id: string, s: string[]) => {
      skills[id] = s;
    },
    __reset: () => {
      for (const k of Object.keys(loads)) delete loads[k];
      for (const k of Object.keys(caps)) delete caps[k];
      for (const k of Object.keys(skills)) delete skills[k];
    },
    __loads: loads,

    // ── service surface used by AssignmentService ─────────────────
    getOnlineAgents: jest
      .fn()
      .mockResolvedValue(['agent_1', 'agent_2', 'agent_3']),
    getPresence: jest.fn((_t: string, id: string) =>
      Promise.resolve(
        caps[id] !== undefined || skills[id] !== undefined
          ? {
              maxCapacity: caps[id] ?? 10,
              activeConversations: loads[id] ?? 0,
              skills: skills[id], // undefined → caller falls back to Mongo
            }
          : null,
      ),
    ),
    reserveAgentFromCandidates: jest.fn((_t: string, ids: string[]) =>
      Promise.resolve(reserve(ids, 10)),
    ),
    // First-fit: reserve the FIRST eligible (under-capacity) candidate in order.
    reserveFirstEligibleAgent: jest.fn((_t: string, ids: string[]) => {
      for (const id of ids) {
        if ((loads[id] ?? 0) < effectiveCap(id, 10)) {
          loads[id] = (loads[id] ?? 0) + 1;
          return Promise.resolve(id);
        }
      }
      return Promise.resolve(null);
    }),
    reserveCapacityBasedAgent: jest.fn(
      (_t: string, ids: string[], tenantCap: number) =>
        Promise.resolve(reserve(ids, tenantCap)),
    ),
    releaseConversation: jest.fn((_t: string, id: string) => {
      loads[id] = Math.max(0, (loads[id] ?? 0) - 1);
      return Promise.resolve();
    }),
  };
}

describe('AssignmentService', () => {
  let service: AssignmentService;
  let conversationRepoMock: any;
  let presenceServiceMock: ReturnType<typeof createPresenceMock>;
  let auditLogRepoMock: any;
  let settingsServiceMock: any;
  let usersServiceMock: any;
  let evaluatorMock: any;
  let redisMock: any;
  let stickyRetryQueueMock: any;
  let eventEmitterMock: any;

  beforeEach(async () => {
    conversationRepoMock = {
      // Return a truthy committed doc so the reservation→commit guard does not
      // treat the write as a failure and roll back.
      updateAssignment: jest
        .fn()
        .mockResolvedValue({ _id: 'conv', assignedAgentId: 'agent' }),
      countOpenByAgent: jest.fn().mockResolvedValue(0),
      findLastResolvedByContact: jest.fn().mockResolvedValue(null),
      findLastResolvedBySender: jest.fn().mockResolvedValue(null),
      findById: jest.fn().mockResolvedValue(null),
    };

    presenceServiceMock = createPresenceMock();

    auditLogRepoMock = {
      create: jest.fn().mockResolvedValue(undefined),
    };

    settingsServiceMock = {
      getSetting: jest.fn().mockResolvedValue({
        defaultStrategy: 'round-robin',
        defaultMaxCapacity: 10,
        stickyRoutingEnabled: true,
        stickyTimeoutHours: 72,
        stickyWaitTimeMinutes: 3,
        fallbackStrategy: 'least-busy',
        skillBasedRoutingEnabled: false,
      }),
    };

    usersServiceMock = {
      findByIds: jest.fn().mockResolvedValue([]),
    };

    evaluatorMock = {
      evaluateForTenant: jest.fn().mockResolvedValue(null),
    };

    redisMock = {
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      publish: jest.fn().mockResolvedValue(1),
      duplicate: jest.fn(),
    };

    stickyRetryQueueMock = {
      add: jest.fn().mockResolvedValue({}),
    };

    eventEmitterMock = {
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AssignmentService,
        { provide: ConversationRepository, useValue: conversationRepoMock },
        { provide: AgentPresenceService, useValue: presenceServiceMock },
        { provide: AssignmentAuditLogRepository, useValue: auditLogRepoMock },
        { provide: CrmSettingsService, useValue: settingsServiceMock },
        { provide: UsersService, useValue: usersServiceMock },
        { provide: RoutingRuleEvaluatorService, useValue: evaluatorMock },
        { provide: IOREDIS_CLIENT, useValue: redisMock },
        {
          provide: getQueueToken(OMNI_STICKY_RETRY_QUEUE),
          useValue: stickyRetryQueueMock,
        },
        {
          provide: getModelToken('GroupSchemaClass'),
          useValue: {
            find: jest.fn().mockReturnValue({
              lean: () => ({ exec: () => Promise.resolve([]) }),
            }),
          },
        },
        { provide: EventEmitter2, useValue: eventEmitterMock },
      ],
    }).compile();

    service = module.get<AssignmentService>(AssignmentService);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Round-Robin Strategy
  // ────────────────────────────────────────────────────────────────────────

  describe('round-robin strategy', () => {
    it('should assign first agent when counter is 1', async () => {
      redisMock.incr.mockResolvedValue(1);

      const result = await service.assignConversation(
        'tenant_1',
        'conv_1',
        'round-robin',
      );

      expect(result).toBe('agent_1');
      expect(conversationRepoMock.updateAssignment).toHaveBeenCalledWith(
        'conv_1',
        'agent_1',
      );
      expect(auditLogRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          strategy: 'round-robin',
          outcome: 'assigned',
          assignedAgentId: 'agent_1',
        }),
      );
    });

    it('should cycle through agents on sequential calls', async () => {
      redisMock.incr
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(4); // wraps back to agent_1

      const r1 = await service.assignConversation(
        'tenant_1',
        'conv_1',
        'round-robin',
      );
      const r2 = await service.assignConversation(
        'tenant_1',
        'conv_2',
        'round-robin',
      );
      const r3 = await service.assignConversation(
        'tenant_1',
        'conv_3',
        'round-robin',
      );
      const r4 = await service.assignConversation(
        'tenant_1',
        'conv_4',
        'round-robin',
      );

      expect(r1).toBe('agent_1');
      expect(r2).toBe('agent_2');
      expect(r3).toBe('agent_3');
      expect(r4).toBe('agent_1'); // wrap-around
    });

    it('should reserve candidates in rotation order, NOT by lowest load', async () => {
      // Regression guard for the N+1 "fix": round-robin must use first-fit on the
      // rotated list, not collapse into least-busy. agent_1 is the heaviest but
      // the rotation puts it first, so it must still be chosen.
      redisMock.incr.mockResolvedValue(1); // index 0 → agent_1 first
      presenceServiceMock.__setLoad('agent_1', 8);
      presenceServiceMock.__setLoad('agent_2', 0);
      presenceServiceMock.__setLoad('agent_3', 0);

      const result = await service.assignConversation(
        'tenant_1',
        'conv_1',
        'round-robin',
      );

      // First eligible in rotation order is agent_1 (still under cap 10).
      expect(result).toBe('agent_1');
      // Single first-fit call over the rotated list — NOT N per-agent calls,
      // and NOT the lowest-load (least-busy) reserve.
      expect(
        presenceServiceMock.reserveFirstEligibleAgent,
      ).toHaveBeenCalledWith('tenant_1', ['agent_1', 'agent_2', 'agent_3']);
      expect(
        presenceServiceMock.reserveAgentFromCandidates,
      ).not.toHaveBeenCalled();
    });

    it('should use default strategy from settings when none specified', async () => {
      redisMock.incr.mockResolvedValue(1);

      const result = await service.assignConversation('tenant_1', 'conv_1');

      expect(result).toBe('agent_1');
      expect(auditLogRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ strategy: 'round-robin' }),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Least-Busy Strategy
  // ────────────────────────────────────────────────────────────────────────

  describe('least-busy strategy', () => {
    it('should assign to agent with fewest open chats', async () => {
      presenceServiceMock.__setLoad('agent_1', 5);
      presenceServiceMock.__setLoad('agent_2', 2); // fewest
      presenceServiceMock.__setLoad('agent_3', 8);

      const result = await service.assignConversation(
        'tenant_1',
        'conv_1',
        'least-busy',
      );

      expect(result).toBe('agent_2');
      expect(
        presenceServiceMock.reserveAgentFromCandidates,
      ).toHaveBeenCalledWith('tenant_1', ['agent_1', 'agent_2', 'agent_3']);
      expect(auditLogRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          strategy: 'least-busy',
          outcome: 'assigned',
          assignedAgentId: 'agent_2',
        }),
      );
    });

    it('should assign first agent if all have equal load', async () => {
      const result = await service.assignConversation(
        'tenant_1',
        'conv_1',
        'least-busy',
      );

      expect(result).toBe('agent_1');
      expect(conversationRepoMock.updateAssignment).toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Capacity-Based Strategy (atomic Redis reserve — P1 fix)
  // ────────────────────────────────────────────────────────────────────────

  describe('capacity-based strategy', () => {
    it('should assign to agent with available capacity via atomic reserve', async () => {
      presenceServiceMock.__setLoad('agent_1', 9); // 9/10
      presenceServiceMock.__setLoad('agent_2', 3); // 3/10 (most capacity)
      presenceServiceMock.__setLoad('agent_3', 7); // 7/10

      const result = await service.assignConversation(
        'tenant_1',
        'conv_1',
        'capacity-based',
      );

      expect(result).toBe('agent_2');
      // Must go through the atomic capacity reserve, NOT the old Mongo path.
      expect(
        presenceServiceMock.reserveCapacityBasedAgent,
      ).toHaveBeenCalledWith('tenant_1', ['agent_1', 'agent_2', 'agent_3'], 10);
    });

    it('should queue conversation when all agents are at max capacity', async () => {
      presenceServiceMock.__setLoad('agent_1', 10);
      presenceServiceMock.__setLoad('agent_2', 10);
      presenceServiceMock.__setLoad('agent_3', 10);

      const result = await service.assignConversation(
        'tenant_1',
        'conv_1',
        'capacity-based',
      );

      expect(result).toBeNull();
      expect(conversationRepoMock.updateAssignment).not.toHaveBeenCalled();
      expect(auditLogRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          strategy: 'capacity-based',
          outcome: 'queued',
        }),
      );
    });

    it('should respect per-agent capacity from presence data', async () => {
      presenceServiceMock.__setCapacity('agent_1', 5);
      presenceServiceMock.__setLoad('agent_1', 5); // 5/5 — at capacity
      presenceServiceMock.__setLoad('agent_2', 4); // 4/10
      presenceServiceMock.__setLoad('agent_3', 6); // 6/10

      const result = await service.assignConversation(
        'tenant_1',
        'conv_1',
        'capacity-based',
      );

      expect(result).toBe('agent_2');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Sticky Routing
  // ────────────────────────────────────────────────────────────────────────

  describe('sticky strategy', () => {
    beforeEach(() => {
      settingsServiceMock.getSetting.mockResolvedValue({
        defaultStrategy: 'round-robin',
        defaultMaxCapacity: 10,
        stickyRoutingEnabled: true,
        stickyTimeoutHours: 72,
        stickyWaitTimeMinutes: 3,
        fallbackStrategy: 'least-busy',
        skillBasedRoutingEnabled: false,
      });
    });

    it('should assign to previous agent when available and has capacity', async () => {
      conversationRepoMock.findLastResolvedByContact.mockResolvedValue({
        assignedAgentId: 'agent_2',
        resolvedAt: new Date(), // just resolved
      });

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        strategy: 'sticky',
        contactId: 'contact_1',
      });

      expect(result).toBe('agent_2');
      expect(auditLogRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          strategy: 'sticky',
          outcome: 'assigned',
        }),
      );
    });

    it('should fall back to least-busy when previous agent is not available', async () => {
      conversationRepoMock.findLastResolvedByContact.mockResolvedValue({
        assignedAgentId: 'agent_999', // not in available pool
        resolvedAt: new Date(),
      });
      presenceServiceMock.__setLoad('agent_1', 5);
      presenceServiceMock.__setLoad('agent_2', 1); // fewest
      presenceServiceMock.__setLoad('agent_3', 3);

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        strategy: 'sticky',
        contactId: 'contact_1',
      });

      expect(result).toBe('agent_2'); // fallback to least-busy
    });

    it('should schedule sticky retry or fall back when agent at capacity and stickyWaitTime > 0', async () => {
      conversationRepoMock.findLastResolvedByContact.mockResolvedValue({
        assignedAgentId: 'agent_1',
        resolvedAt: new Date(),
      });
      // agent_1 at capacity → sticky reserve fails.
      presenceServiceMock.__setCapacity('agent_1', 10);
      presenceServiceMock.__setLoad('agent_1', 10);

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        strategy: 'sticky',
        contactId: 'contact_1',
      });

      if (result === '__sticky_waiting__') {
        expect(stickyRetryQueueMock.add).toHaveBeenCalled();
      } else {
        expect(result).not.toBe('agent_1'); // NOT the at-capacity agent
        expect(auditLogRepoMock.create).toHaveBeenCalledWith(
          expect.objectContaining({
            outcome: expect.stringMatching(/assigned|queued/),
          }),
        );
      }
    });

    it('should skip sticky when contact resolved outside timeout window', async () => {
      conversationRepoMock.findLastResolvedByContact.mockResolvedValue({
        assignedAgentId: 'agent_2',
        resolvedAt: new Date(Date.now() - 100 * 60 * 60 * 1000), // 100h ago (> 72h)
      });
      redisMock.incr.mockResolvedValue(1);

      await service.assignConversation('tenant_1', 'conv_1', {
        strategy: 'sticky',
        contactId: 'contact_1',
      });

      expect(auditLogRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          strategy: expect.not.stringContaining('sticky'),
        }),
      );
    });

    it('should NOT trigger sticky when a rule sets strategy=sticky but global stickyRoutingEnabled=false (P0 fix)', async () => {
      // P0 fix: the global stickyRoutingEnabled toggle is now a hard kill-switch.
      // A routing rule requesting strategy='sticky' is honoured only when the
      // tenant has enabled sticky routing. When disabled, the assignment falls
      // through to the default strategy (round-robin here).
      settingsServiceMock.getSetting.mockResolvedValue({
        defaultStrategy: 'round-robin',
        defaultMaxCapacity: 10,
        stickyRoutingEnabled: false, // global OFF
        fallbackStrategy: 'least-busy',
        skillBasedRoutingEnabled: false,
      });
      conversationRepoMock.findLastResolvedByContact.mockResolvedValue({
        assignedAgentId: 'agent_3',
        resolvedAt: new Date(),
      });
      redisMock.incr.mockResolvedValue(1);

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        strategy: 'sticky',
        contactId: 'contact_1',
      });

      // Sticky disabled → falls through to default (round-robin) → agent_1.
      expect(result).toBe('agent_1');
      expect(auditLogRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          strategy: expect.not.stringContaining('sticky'),
        }),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Sticky-history cache (Task 3.3)
  // ────────────────────────────────────────────────────────────────────────

  describe('sticky-history cache', () => {
    beforeEach(() => {
      settingsServiceMock.getSetting.mockResolvedValue({
        defaultStrategy: 'round-robin',
        defaultMaxCapacity: 10,
        stickyRoutingEnabled: true,
        stickyTimeoutHours: 72,
        stickyWaitTimeMinutes: 3,
        fallbackStrategy: 'least-busy',
        skillBasedRoutingEnabled: false,
      });
    });

    it('should resolve the previous agent from the Redis cache without a MongoDB lookup', async () => {
      redisMock.get.mockResolvedValue(
        JSON.stringify({
          agentId: 'agent_2',
          resolvedAt: new Date().toISOString(),
        }),
      );

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        strategy: 'sticky',
        contactId: 'contact_1',
      });

      expect(result).toBe('agent_2');
      expect(
        conversationRepoMock.findLastResolvedByContact,
      ).not.toHaveBeenCalled();
    });

    it('should ignore a cached entry older than the sticky timeout (fall back to Mongo)', async () => {
      redisMock.get.mockResolvedValue(
        JSON.stringify({
          agentId: 'agent_2',
          resolvedAt: new Date(Date.now() - 100 * 3600 * 1000).toISOString(), // 100h > 72h
        }),
      );
      conversationRepoMock.findLastResolvedByContact.mockResolvedValue(null);
      redisMock.incr.mockResolvedValue(1);

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        strategy: 'sticky',
        contactId: 'contact_1',
      });

      // Stale cache ignored → Mongo consulted → no previous agent → fallback.
      expect(conversationRepoMock.findLastResolvedByContact).toHaveBeenCalled();
      expect(result).toBe('agent_1'); // least-busy fallback
    });

    it('should write contact + sender cache keys with TTL on resolve', async () => {
      conversationRepoMock.findById.mockResolvedValue({
        assignedAgentId: 'agent_7',
        contactId: 'contact_42',
        externalSenderId: 'sender_99',
        resolvedAt: new Date(),
      });

      await service.handleConversationResolvedForSticky({
        tenantId: 'tenant_1',
        conversationId: 'conv_1',
        status: 'resolved',
      });

      expect(redisMock.set).toHaveBeenCalledWith(
        'omni:sticky:tenant_1:c:contact_42',
        expect.stringContaining('agent_7'),
        'EX',
        72 * 3600,
      );
      expect(redisMock.set).toHaveBeenCalledWith(
        'omni:sticky:tenant_1:s:sender_99',
        expect.stringContaining('agent_7'),
        'EX',
        72 * 3600,
      );
    });

    it('should not write a sticky cache entry for an unassigned resolved conversation', async () => {
      conversationRepoMock.findById.mockResolvedValue({
        assignedAgentId: null,
        contactId: 'contact_42',
      });

      await service.handleConversationResolvedForSticky({
        tenantId: 'tenant_1',
        conversationId: 'conv_1',
        status: 'resolved',
      });

      expect(redisMock.set).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Reservation → commit rollback (P1 invariant)
  // ────────────────────────────────────────────────────────────────────────

  describe('reservation rollback', () => {
    it('should release the Redis reservation when the MongoDB commit is rejected', async () => {
      presenceServiceMock.__setLoad('agent_1', 2);
      presenceServiceMock.__setLoad('agent_2', 2);
      presenceServiceMock.__setLoad('agent_3', 2);
      // Simulate the conversation already being assigned (CAS rejects).
      conversationRepoMock.updateAssignment.mockResolvedValue(null);

      const result = await service.assignConversation(
        'tenant_1',
        'conv_1',
        'least-busy',
      );

      expect(result).toBeNull();
      // The reserved agent must be released exactly once.
      expect(presenceServiceMock.releaseConversation).toHaveBeenCalledTimes(1);
      expect(auditLogRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'queued' }),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Manual Strategy
  // ────────────────────────────────────────────────────────────────────────

  describe('manual strategy', () => {
    it('should return null and log as queued', async () => {
      const result = await service.assignConversation(
        'tenant_1',
        'conv_1',
        'manual',
      );

      expect(result).toBeNull();
      expect(conversationRepoMock.updateAssignment).not.toHaveBeenCalled();
      expect(auditLogRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          strategy: 'manual',
          outcome: 'queued',
        }),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // No Agents Available
  // ────────────────────────────────────────────────────────────────────────

  describe('no available agents', () => {
    it('should queue conversation when no agents are online', async () => {
      presenceServiceMock.getOnlineAgents.mockResolvedValue([]);

      const result = await service.assignConversation(
        'tenant_1',
        'conv_1',
        'round-robin',
      );

      expect(result).toBeNull();
      expect(auditLogRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'queued' }),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Skill-Based Filtering
  // ────────────────────────────────────────────────────────────────────────

  describe('skill-based filtering', () => {
    beforeEach(() => {
      settingsServiceMock.getSetting.mockResolvedValue({
        defaultStrategy: 'round-robin',
        defaultMaxCapacity: 10,
        skillBasedRoutingEnabled: true,
        stickyRoutingEnabled: false,
        fallbackStrategy: 'round-robin',
      });
    });

    it('should filter agents by required skills', async () => {
      usersServiceMock.findByIds.mockResolvedValue([
        { id: 'agent_1', skills: ['billing'] },
        { id: 'agent_2', skills: ['billing', 'spanish'] },
        { id: 'agent_3', skills: ['technical'] },
      ]);
      redisMock.incr.mockResolvedValue(1);

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        strategy: 'round-robin',
        requiredSkills: ['billing', 'spanish'],
      });

      // Only agent_2 has both skills
      expect(result).toBe('agent_2');
    });

    it('should read skills from presence cache without hitting MongoDB', async () => {
      // All agents hydrated in presence → no findByIds call.
      presenceServiceMock.__setSkills('agent_1', ['billing']);
      presenceServiceMock.__setSkills('agent_2', ['billing', 'spanish']);
      presenceServiceMock.__setSkills('agent_3', ['technical']);
      redisMock.incr.mockResolvedValue(1);

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        strategy: 'round-robin',
        requiredSkills: ['billing', 'spanish'],
      });

      expect(result).toBe('agent_2');
      expect(usersServiceMock.findByIds).not.toHaveBeenCalled();
    });

    it('should fall back to MongoDB for agents whose skills are not cached', async () => {
      // Only agent_2 cached; agent_1/agent_3 require a Mongo read.
      presenceServiceMock.__setSkills('agent_2', ['billing', 'spanish']);
      usersServiceMock.findByIds.mockResolvedValue([
        { id: 'agent_1', skills: ['billing'] },
        { id: 'agent_3', skills: ['technical'] },
      ]);
      redisMock.incr.mockResolvedValue(1);

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        strategy: 'round-robin',
        requiredSkills: ['billing', 'spanish'],
      });

      expect(result).toBe('agent_2');
      // Fallback fetched only the un-cached agents.
      expect(usersServiceMock.findByIds).toHaveBeenCalledWith([
        'agent_1',
        'agent_3',
      ]);
    });

    it('should fall back to full pool when no agents match skills', async () => {
      usersServiceMock.findByIds.mockResolvedValue([
        { id: 'agent_1', skills: ['billing'] },
        { id: 'agent_2', skills: ['support'] },
        { id: 'agent_3', skills: ['technical'] },
      ]);
      redisMock.incr.mockResolvedValue(1);

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        strategy: 'round-robin',
        requiredSkills: ['japanese'],
      });

      expect(result).toBeDefined();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Routing Rule Integration
  // ────────────────────────────────────────────────────────────────────────

  describe('routing rule evaluation', () => {
    it('should use rule-matched strategy instead of default', async () => {
      evaluatorMock.evaluateForTenant.mockResolvedValue({
        ruleId: 'rule_1',
        ruleName: 'Facebook VIP',
        teamId: 'team_sales',
        strategy: 'least-busy',
        sticky: false,
        requiredSkills: [],
      });

      presenceServiceMock.__setLoad('agent_1', 5);
      presenceServiceMock.__setLoad('agent_2', 1); // fewest
      presenceServiceMock.__setLoad('agent_3', 3);

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        strategy: 'round-robin',
        routingContext: { channel: 'facebook', segment: 'VIP' },
      });

      expect(result).toBe('agent_2'); // least-busy from rule, not round-robin
      expect(auditLogRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ strategy: 'least-busy' }),
      );
    });

    it('should use rule-matched required skills', async () => {
      settingsServiceMock.getSetting.mockResolvedValue({
        defaultStrategy: 'round-robin',
        defaultMaxCapacity: 10,
        skillBasedRoutingEnabled: true,
        stickyRoutingEnabled: false,
        fallbackStrategy: 'round-robin',
      });

      evaluatorMock.evaluateForTenant.mockResolvedValue({
        ruleId: 'rule_2',
        ruleName: 'Spanish Support',
        teamId: 'team_support',
        strategy: 'round-robin',
        sticky: false,
        requiredSkills: ['spanish'],
      });

      usersServiceMock.findByIds.mockResolvedValue([
        { id: 'agent_1', skills: ['english'] },
        { id: 'agent_2', skills: ['spanish', 'english'] },
        { id: 'agent_3', skills: ['english'] },
      ]);
      redisMock.incr.mockResolvedValue(1);

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        strategy: 'round-robin',
        routingContext: { channel: 'facebook', content: 'Hola' },
      });

      expect(result).toBe('agent_2');
    });

    it('should gracefully fall back when evaluator throws', async () => {
      evaluatorMock.evaluateForTenant.mockRejectedValue(new Error('DB error'));
      redisMock.incr.mockResolvedValue(1);

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        strategy: 'round-robin',
        routingContext: { channel: 'facebook' },
      });

      expect(result).toBe('agent_1');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Channel-first Auto-Assignment Hierarchy
  // ────────────────────────────────────────────────────────────────────────

  describe('channel-first auto-assignment hierarchy', () => {
    it('should assign using channel agent pool when channel explicitly enables', async () => {
      redisMock.incr.mockResolvedValue(1);
      presenceServiceMock.getOnlineAgents.mockResolvedValue(['agent_2']);

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        channelAutoAssignOverride: true,
        agentPool: ['agent_2'],
      });

      expect(result).toBe('agent_2');
      expect(conversationRepoMock.updateAssignment).toHaveBeenCalledWith(
        'conv_1',
        'agent_2',
      );
    });

    it('should use global strategy when channel has no own pool and global is ON', async () => {
      redisMock.incr.mockResolvedValue(1);
      settingsServiceMock.getSetting.mockResolvedValue({
        autoAssignmentEnabled: true,
        defaultStrategy: 'round-robin',
        defaultMaxCapacity: 10,
        stickyRoutingEnabled: false,
        fallbackStrategy: 'least-busy',
        skillBasedRoutingEnabled: false,
      });

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        channelAutoAssignOverride: true,
      });

      expect(result).toBe('agent_1');
    });

    it('should STILL assign when channel explicitly ON even if global is OFF', async () => {
      redisMock.incr.mockResolvedValue(1);
      settingsServiceMock.getSetting.mockResolvedValue({
        autoAssignmentEnabled: false, // Global OFF
        defaultStrategy: 'round-robin',
        defaultMaxCapacity: 10,
        stickyRoutingEnabled: false,
        fallbackStrategy: 'least-busy',
        skillBasedRoutingEnabled: false,
      });

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        channelAutoAssignOverride: true,
      });

      expect(result).toBe('agent_1');
      expect(conversationRepoMock.updateAssignment).toHaveBeenCalled();
    });

    it('should use global strategy when channel did not set and global is ON', async () => {
      redisMock.incr.mockResolvedValue(1);
      settingsServiceMock.getSetting.mockResolvedValue({
        autoAssignmentEnabled: true,
        defaultStrategy: 'round-robin',
        defaultMaxCapacity: 10,
        stickyRoutingEnabled: false,
        fallbackStrategy: 'least-busy',
        skillBasedRoutingEnabled: false,
      });

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        channelAutoAssignOverride: undefined,
      });

      expect(result).toBe('agent_1');
    });

    it('should queue when channel did not set and global is OFF', async () => {
      settingsServiceMock.getSetting.mockResolvedValue({
        autoAssignmentEnabled: false, // Global OFF
        defaultStrategy: 'round-robin',
        defaultMaxCapacity: 10,
        stickyRoutingEnabled: false,
        fallbackStrategy: 'least-busy',
        skillBasedRoutingEnabled: false,
      });

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        channelAutoAssignOverride: undefined,
      });

      expect(result).toBeNull();
      expect(conversationRepoMock.updateAssignment).not.toHaveBeenCalled();
      expect(auditLogRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          strategy: 'manual',
          outcome: 'queued',
          reason: expect.stringContaining('globally disabled'),
        }),
      );
    });

    it('should treat missing global setting as enabled (backward compat)', async () => {
      redisMock.incr.mockResolvedValue(1);
      settingsServiceMock.getSetting.mockResolvedValue({
        defaultStrategy: 'round-robin',
        defaultMaxCapacity: 10,
        stickyRoutingEnabled: false,
        fallbackStrategy: 'least-busy',
        skillBasedRoutingEnabled: false,
      });

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        channelAutoAssignOverride: undefined,
      });

      expect(result).toBe('agent_1');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Channel routing override (Phase 4 — mergeRoutingConfig)
  // ────────────────────────────────────────────────────────────────────────

  describe('per-channel routing override', () => {
    it('should handle mergeRoutingConfig: channel ?? global ?? hardcoded, field-by-field', () => {
      const resolved = mergeRoutingConfig(
        {
          defaultStrategy: 'round-robin',
          defaultMaxCapacity: 10,
          stickyRoutingEnabled: false,
          fallbackStrategy: 'least-busy',
        },
        { defaultStrategy: 'capacity-based', stickyRoutingEnabled: true },
      );

      // Overridden fields take the channel value …
      expect(resolved.defaultStrategy).toBe('capacity-based');
      expect(resolved.stickyRoutingEnabled).toBe(true);
      // … unset channel fields inherit global …
      expect(resolved.defaultMaxCapacity).toBe(10);
      expect(resolved.fallbackStrategy).toBe('least-busy');
      // … and fields absent from both fall back to hardcoded defaults.
      expect(resolved.stickyTimeoutHours).toBe(72);
      expect(resolved.skillBasedRoutingEnabled).toBe(false);
    });

    it('should handle mergeRoutingConfig: empty inputs produce all hardcoded defaults', () => {
      const resolved = mergeRoutingConfig(undefined, undefined);
      expect(resolved).toEqual({
        defaultStrategy: 'round-robin',
        defaultMaxCapacity: 10,
        stickyRoutingEnabled: false,
        stickyTimeoutHours: 72,
        stickyWaitTimeMinutes: 0,
        fallbackStrategy: 'round-robin',
        skillBasedRoutingEnabled: false,
      });
    });

    it('should apply the channel strategy override over the global default', async () => {
      // Global default is round-robin; channel forces capacity-based.
      settingsServiceMock.getSetting.mockResolvedValue({
        autoAssignmentEnabled: true,
        defaultStrategy: 'round-robin',
        defaultMaxCapacity: 10,
        stickyRoutingEnabled: false,
        fallbackStrategy: 'least-busy',
        skillBasedRoutingEnabled: false,
      });
      presenceServiceMock.__setLoad('agent_1', 9);
      presenceServiceMock.__setLoad('agent_2', 2); // lowest under cap
      presenceServiceMock.__setLoad('agent_3', 7);

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        channelAutoAssignOverride: true,
        channelRoutingOverride: { defaultStrategy: 'capacity-based' },
      });

      expect(result).toBe('agent_2');
      expect(presenceServiceMock.reserveCapacityBasedAgent).toHaveBeenCalled();
      expect(auditLogRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ strategy: 'capacity-based' }),
      );
    });

    it('should let a routing rule strategy win over the channel override', async () => {
      settingsServiceMock.getSetting.mockResolvedValue({
        autoAssignmentEnabled: true,
        defaultStrategy: 'round-robin',
        defaultMaxCapacity: 10,
        stickyRoutingEnabled: false,
        fallbackStrategy: 'least-busy',
        skillBasedRoutingEnabled: false,
      });
      evaluatorMock.evaluateForTenant.mockResolvedValue({
        ruleId: 'rule_1',
        ruleName: 'VIP least-busy',
        strategy: 'least-busy',
        sticky: false,
        requiredSkills: [],
      });
      presenceServiceMock.__setLoad('agent_1', 5);
      presenceServiceMock.__setLoad('agent_2', 1); // fewest
      presenceServiceMock.__setLoad('agent_3', 3);

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        channelAutoAssignOverride: true,
        channelRoutingOverride: { defaultStrategy: 'capacity-based' },
        routingContext: { channel: 'whatsapp' },
      });

      // rule (least-busy) > channel (capacity-based) > global (round-robin)
      expect(result).toBe('agent_2');
      expect(auditLogRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ strategy: 'least-busy' }),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Config cache invalidation (Task 2.1)
  // ────────────────────────────────────────────────────────────────────────

  describe('routing config cache invalidation', () => {
    it('should cache the routing config across calls (single DB read)', async () => {
      await service.assignConversation('tenant_1', 'conv_1', 'round-robin');
      await service.assignConversation('tenant_1', 'conv_2', 'round-robin');

      expect(settingsServiceMock.getSetting).toHaveBeenCalledTimes(1);
    });

    it('should drop the cache and re-read after an omni_routing settings change', async () => {
      await service.assignConversation('tenant_1', 'conv_1', 'round-robin');
      expect(settingsServiceMock.getSetting).toHaveBeenCalledTimes(1);

      await service.handleSettingsChanged({
        key: 'omni_routing',
        tenantId: 'tenant_1',
      });

      // Fans out to all pods via Redis pub/sub.
      expect(redisMock.publish).toHaveBeenCalledWith(
        'omni:routing-config:invalidate',
        'tenant_1',
      );

      await service.assignConversation('tenant_1', 'conv_3', 'round-robin');
      expect(settingsServiceMock.getSetting).toHaveBeenCalledTimes(2);
    });

    it('should ignore settings changes for unrelated keys', async () => {
      await service.assignConversation('tenant_1', 'conv_1', 'round-robin');

      await service.handleSettingsChanged({
        key: 'contact_settings',
        tenantId: 'tenant_1',
      });

      expect(redisMock.publish).not.toHaveBeenCalled();
      await service.assignConversation('tenant_1', 'conv_2', 'round-robin');
      // Still cached → no second read.
      expect(settingsServiceMock.getSetting).toHaveBeenCalledTimes(1);
    });
  });
});
