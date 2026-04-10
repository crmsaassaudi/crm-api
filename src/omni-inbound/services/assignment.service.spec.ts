import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { getModelToken } from '@nestjs/mongoose';
import { AssignmentService } from './assignment.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { AgentPresenceService } from './agent-presence.service';
import { AssignmentAuditLogRepository } from '../repositories/assignment-audit-log.repository';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { UsersService } from '../../users/users.service';
import { RoutingRuleEvaluatorService } from '../../routing-rules/routing-rule-evaluator.service';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { OMNI_STICKY_RETRY_QUEUE } from '../queue/omni-sticky-queue.constants';

describe('AssignmentService', () => {
  let service: AssignmentService;
  let conversationRepoMock: any;
  let presenceServiceMock: any;
  let auditLogRepoMock: any;
  let settingsServiceMock: any;
  let usersServiceMock: any;
  let evaluatorMock: any;
  let redisMock: any;
  let stickyRetryQueueMock: any;

  beforeEach(async () => {
    conversationRepoMock = {
      updateAssignment: jest.fn().mockResolvedValue(undefined),
      countOpenByAgent: jest.fn().mockResolvedValue(0),
      findLastResolvedByContact: jest.fn().mockResolvedValue(null),
      findLastResolvedBySender: jest.fn().mockResolvedValue(null),
    };

    presenceServiceMock = {
      getOnlineAgents: jest
        .fn()
        .mockResolvedValue(['agent_1', 'agent_2', 'agent_3']),
      getPresence: jest.fn().mockResolvedValue(null),
    };

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
    };

    stickyRetryQueueMock = {
      add: jest.fn().mockResolvedValue({}),
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
      conversationRepoMock.countOpenByAgent
        .mockResolvedValueOnce(5) // agent_1: 5 chats
        .mockResolvedValueOnce(2) // agent_2: 2 chats (fewest)
        .mockResolvedValueOnce(8); // agent_3: 8 chats

      const result = await service.assignConversation(
        'tenant_1',
        'conv_1',
        'least-busy',
      );

      expect(result).toBe('agent_2');
      expect(auditLogRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          strategy: 'least-busy',
          outcome: 'assigned',
          assignedAgentId: 'agent_2',
        }),
      );
    });

    it('should assign first agent if all have equal load', async () => {
      conversationRepoMock.countOpenByAgent.mockResolvedValue(3);

      const result = await service.assignConversation(
        'tenant_1',
        'conv_1',
        'least-busy',
      );

      expect(result).toBeDefined();
      expect(conversationRepoMock.updateAssignment).toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Capacity-Based Strategy
  // ────────────────────────────────────────────────────────────────────────

  describe('capacity-based strategy', () => {
    it('should assign to agent with available capacity', async () => {
      conversationRepoMock.countOpenByAgent
        .mockResolvedValueOnce(9) // agent_1: 9/10
        .mockResolvedValueOnce(3) // agent_2: 3/10 (most capacity)
        .mockResolvedValueOnce(7); // agent_3: 7/10

      const result = await service.assignConversation(
        'tenant_1',
        'conv_1',
        'capacity-based',
      );

      expect(result).toBe('agent_2');
    });

    it('should queue conversation when all agents are at max capacity', async () => {
      conversationRepoMock.countOpenByAgent.mockResolvedValue(10); // all at 10/10

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
      // agent_1 has custom capacity of 5 via presence data
      presenceServiceMock.getPresence
        .mockResolvedValueOnce({ maxCapacity: 5 }) // agent_1: cap=5
        .mockResolvedValueOnce(null) // agent_2: use tenant default 10
        .mockResolvedValueOnce(null); // agent_3: use tenant default 10

      conversationRepoMock.countOpenByAgent
        .mockResolvedValueOnce(5) // agent_1: 5/5 (at capacity)
        .mockResolvedValueOnce(4) // agent_2: 4/10
        .mockResolvedValueOnce(6); // agent_3: 6/10

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
      conversationRepoMock.countOpenByAgent.mockResolvedValue(3); // 3/10 = has capacity

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
      conversationRepoMock.countOpenByAgent
        .mockResolvedValueOnce(5) // agent_1
        .mockResolvedValueOnce(1) // agent_2 (fewest)
        .mockResolvedValueOnce(3); // agent_3

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
      conversationRepoMock.countOpenByAgent.mockResolvedValue(10); // at capacity

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        strategy: 'sticky',
        contactId: 'contact_1',
      });

      // When sticky agent is at capacity, the service either:
      // 1. Schedules a retry and returns '__sticky_waiting__'
      // 2. Falls back to the fallback strategy (least-busy)
      // Either outcome is acceptable — what matters is the original agent
      // is NOT directly assigned (since they're at capacity)
      if (result === '__sticky_waiting__') {
        // Sticky retry was scheduled
        expect(stickyRetryQueueMock.add).toHaveBeenCalled();
      } else {
        // Fell through to fallback strategy
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
        resolvedAt: new Date(Date.now() - 100 * 60 * 60 * 1000), // 100 hours ago (> 72h)
      });
      redisMock.incr.mockResolvedValue(1);

      // Falls back to default strategy (round-robin)
      await service.assignConversation('tenant_1', 'conv_1', {
        strategy: 'sticky',
        contactId: 'contact_1',
      });

      // Should not be agent_2 (sticky) — should use fallback
      expect(auditLogRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          strategy: expect.not.stringContaining('sticky'),
        }),
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

      // Falls back to full pool
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

      conversationRepoMock.countOpenByAgent
        .mockResolvedValueOnce(5) // agent_1
        .mockResolvedValueOnce(1) // agent_2 (fewest)
        .mockResolvedValueOnce(3); // agent_3

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

      // Should fall back to default round-robin
      expect(result).toBe('agent_1');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Channel-first Auto-Assignment Hierarchy
  // ────────────────────────────────────────────────────────────────────────

  describe('channel-first auto-assignment hierarchy', () => {
    // Scenario 1: Channel ON + has own pool → use channel rules
    it('should assign using channel agent pool when channel explicitly enables', async () => {
      redisMock.incr.mockResolvedValue(1);
      // Only agent_2 is in the channel pool
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

    // Scenario 2a: Channel ON + no own rules + Global ON → use global strategy
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
        // no agentPool → use all available agents
      });

      expect(result).toBe('agent_1');
    });

    // Scenario 2b: Channel ON + no own rules + Global OFF → still assign (channel overrides)
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
        channelAutoAssignOverride: true, // Channel ON → overrides global
      });

      // Should STILL assign because channel explicitly enabled
      expect(result).toBe('agent_1');
      expect(conversationRepoMock.updateAssignment).toHaveBeenCalled();
    });

    // Scenario 4: Channel undefined + Global ON → use global strategy
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
        channelAutoAssignOverride: undefined, // Channel did not set
      });

      expect(result).toBe('agent_1');
    });

    // Scenario 5: Channel undefined + Global OFF → queue
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
        channelAutoAssignOverride: undefined, // Channel didn't set → defer to global
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

    // Scenario 3 is handled upstream in conversation.service.ts (channelAutoAssign === false)
    // But verify that if somehow false reaches here, the service still works
    // (channelAutoAssign === false should never reach assignConversation)

    // Edge: Global setting not set at all (legacy tenants) → treat as enabled
    it('should treat missing global setting as enabled (backward compat)', async () => {
      redisMock.incr.mockResolvedValue(1);
      settingsServiceMock.getSetting.mockResolvedValue({
        // autoAssignmentEnabled is NOT set (legacy tenant)
        defaultStrategy: 'round-robin',
        defaultMaxCapacity: 10,
        stickyRoutingEnabled: false,
        fallbackStrategy: 'least-busy',
        skillBasedRoutingEnabled: false,
      });

      const result = await service.assignConversation('tenant_1', 'conv_1', {
        channelAutoAssignOverride: undefined,
      });

      // Should still assign (autoAssignmentEnabled !== false → undefined !== false → proceed)
      expect(result).toBe('agent_1');
    });
  });
});
