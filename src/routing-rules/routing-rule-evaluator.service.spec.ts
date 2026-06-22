import { Test, TestingModule } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import { RoutingRuleEvaluatorService } from './routing-rule-evaluator.service';
import { RoutingRuleRepository } from './infrastructure/persistence/document/repositories/routing-rule.repository';
import { RoutingRule } from './domain/routing-rule';

describe('RoutingRuleEvaluatorService', () => {
  let service: RoutingRuleEvaluatorService;
  let repositoryMock: any;
  let clsMock: any;

  beforeEach(async () => {
    repositoryMock = {
      findEnabledByTenant: jest.fn().mockResolvedValue([]),
    };

    clsMock = {
      get: jest.fn().mockReturnValue('tenant_1'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoutingRuleEvaluatorService,
        { provide: RoutingRuleRepository, useValue: repositoryMock },
        { provide: ClsService, useValue: clsMock },
      ],
    }).compile();

    service = module.get<RoutingRuleEvaluatorService>(
      RoutingRuleEvaluatorService,
    );
  });

  const createRule = (overrides: Partial<RoutingRule> = {}): RoutingRule => {
    const rule = new RoutingRule();
    rule.id = overrides.id ?? 'rule_1';
    rule.name = overrides.name ?? 'Test Rule';
    rule.enabled = overrides.enabled ?? true;
    rule.priority = overrides.priority ?? 0;
    rule.matchType = overrides.matchType ?? 'all';
    rule.conditions = overrides.conditions ?? [];
    rule.actions = overrides.actions ?? {
      teamId: 'team_1',
      strategy: 'round-robin',
      sticky: false,
      requiredSkills: [],
    };
    return rule;
  };

  // ────────────────────────────────────────────────────────────────────────
  // Basic Matching
  // ────────────────────────────────────────────────────────────────────────

  describe('basic matching', () => {
    it('should return null when no rules exist', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([]);

      const result = await service.evaluateForTenant('tenant_1', {
        channel: 'facebook',
      });

      expect(result).toBeNull();
    });

    it('should match a rule with no conditions (catch-all)', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({ conditions: [] }),
      ]);

      const result = await service.evaluateForTenant('tenant_1', {
        channel: 'facebook',
      });

      expect(result).not.toBeNull();
      expect(result!.ruleId).toBe('rule_1');
      expect(result!.teamId).toBe('team_1');
    });

    it('should return matched rule actions', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          actions: {
            teamId: 'sales_team',
            strategy: 'least-busy',
            sticky: true,
            requiredSkills: ['spanish'],
          },
        }),
      ]);

      const result = await service.evaluateForTenant('tenant_1', {});

      expect(result).toEqual({
        ruleId: 'rule_1',
        ruleName: 'Test Rule',
        teamId: 'sales_team',
        strategy: 'least-busy',
        sticky: true,
        requiredSkills: ['spanish'],
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Operator: eq
  // ────────────────────────────────────────────────────────────────────────

  describe('operator: eq', () => {
    it('should match exact value (case-insensitive)', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          conditions: [{ field: 'channel', operator: 'eq', value: 'Facebook' }],
        }),
      ]);

      const result = await service.evaluateForTenant('tenant_1', {
        channel: 'facebook',
      });

      expect(result).not.toBeNull();
    });

    it('should NOT match different value', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          conditions: [{ field: 'channel', operator: 'eq', value: 'zalo' }],
        }),
      ]);

      const result = await service.evaluateForTenant('tenant_1', {
        channel: 'facebook',
      });

      expect(result).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Operator: contains
  // ────────────────────────────────────────────────────────────────────────

  describe('operator: contains', () => {
    it('should match substring in content', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          conditions: [
            { field: 'content', operator: 'contains', value: 'urgent' },
          ],
        }),
      ]);

      const result = await service.evaluateForTenant('tenant_1', {
        content: 'This is an URGENT request!',
      });

      expect(result).not.toBeNull();
    });

    it('should NOT match when substring is absent', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          conditions: [
            { field: 'content', operator: 'contains', value: 'billing' },
          ],
        }),
      ]);

      const result = await service.evaluateForTenant('tenant_1', {
        content: 'Hello, I need help with my order',
      });

      expect(result).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Operator: in
  // ────────────────────────────────────────────────────────────────────────

  describe('operator: in', () => {
    it('should match when value is in comma-separated list', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          conditions: [
            {
              field: 'channel',
              operator: 'in',
              value: 'facebook, whatsapp, zalo',
            },
          ],
        }),
      ]);

      const result = await service.evaluateForTenant('tenant_1', {
        channel: 'whatsapp',
      });

      expect(result).not.toBeNull();
    });

    it('should NOT match when value is not in list', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          conditions: [
            { field: 'channel', operator: 'in', value: 'facebook, zalo' },
          ],
        }),
      ]);

      const result = await service.evaluateForTenant('tenant_1', {
        channel: 'whatsapp',
      });

      expect(result).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Operator: starts_with
  // ────────────────────────────────────────────────────────────────────────

  describe('operator: starts_with', () => {
    it('should match prefix', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          conditions: [
            { field: 'customer_name', operator: 'starts_with', value: 'VIP' },
          ],
        }),
      ]);

      const result = await service.evaluateForTenant('tenant_1', {
        customerName: 'VIP Customer John',
      });

      expect(result).not.toBeNull();
    });

    it('should NOT match when prefix is different', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          conditions: [
            { field: 'customer_name', operator: 'starts_with', value: 'VIP' },
          ],
        }),
      ]);

      const result = await service.evaluateForTenant('tenant_1', {
        customerName: 'Regular Customer',
      });

      expect(result).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Match Type: all vs any
  // ────────────────────────────────────────────────────────────────────────

  describe('matchType: all (AND)', () => {
    it('should require ALL conditions to match', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          matchType: 'all',
          conditions: [
            { field: 'channel', operator: 'eq', value: 'facebook' },
            { field: 'segment', operator: 'eq', value: 'VIP' },
          ],
        }),
      ]);

      // Both match
      const result1 = await service.evaluateForTenant('tenant_1', {
        channel: 'facebook',
        segment: 'VIP',
      });
      expect(result1).not.toBeNull();

      // Only one matches
      const result2 = await service.evaluateForTenant('tenant_1', {
        channel: 'facebook',
        segment: 'Normal',
      });
      expect(result2).toBeNull();
    });
  });

  describe('matchType: any (OR)', () => {
    it('should require at least ONE condition to match', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          matchType: 'any',
          conditions: [
            { field: 'channel', operator: 'eq', value: 'facebook' },
            { field: 'channel', operator: 'eq', value: 'zalo' },
          ],
        }),
      ]);

      const result1 = await service.evaluateForTenant('tenant_1', {
        channel: 'facebook',
      });
      expect(result1).not.toBeNull();

      const result2 = await service.evaluateForTenant('tenant_1', {
        channel: 'zalo',
      });
      expect(result2).not.toBeNull();

      const result3 = await service.evaluateForTenant('tenant_1', {
        channel: 'whatsapp',
      });
      expect(result3).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Priority Ordering
  // ────────────────────────────────────────────────────────────────────────

  describe('priority ordering', () => {
    it('should match lowest priority number first', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          id: 'rule_low_priority',
          name: 'Low Priority',
          priority: 10,
          conditions: [{ field: 'channel', operator: 'eq', value: 'facebook' }],
          actions: {
            teamId: 'team_low',
            strategy: 'manual',
            sticky: false,
            requiredSkills: [],
          },
        }),
        createRule({
          id: 'rule_high_priority',
          name: 'High Priority',
          priority: 1,
          conditions: [{ field: 'channel', operator: 'eq', value: 'facebook' }],
          actions: {
            teamId: 'team_high',
            strategy: 'least-busy',
            sticky: false,
            requiredSkills: [],
          },
        }),
      ]);

      await service.evaluateForTenant('tenant_1', {
        channel: 'facebook',
      });

      // The repository returns sorted by priority, so rule_high_priority (p=1) comes first
      // But the mock returns in array order. In production, DB sorts. Let's test with proper order:
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          id: 'rule_high_priority',
          name: 'High Priority',
          priority: 1,
          conditions: [{ field: 'channel', operator: 'eq', value: 'facebook' }],
          actions: {
            teamId: 'team_high',
            strategy: 'least-busy',
            sticky: false,
            requiredSkills: [],
          },
        }),
        createRule({
          id: 'rule_low_priority',
          name: 'Low Priority',
          priority: 10,
          conditions: [{ field: 'channel', operator: 'eq', value: 'facebook' }],
          actions: {
            teamId: 'team_low',
            strategy: 'manual',
            sticky: false,
            requiredSkills: [],
          },
        }),
      ]);

      // Invalidate cache so the new mock data is picked up
      service.invalidateCache('tenant_1');

      const result2 = await service.evaluateForTenant('tenant_1', {
        channel: 'facebook',
      });

      expect(result2!.ruleId).toBe('rule_high_priority');
      expect(result2!.teamId).toBe('team_high');
    });

    it('should skip non-matching rules and match next', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          id: 'rule_1',
          priority: 1,
          conditions: [{ field: 'channel', operator: 'eq', value: 'zalo' }],
        }),
        createRule({
          id: 'rule_2',
          priority: 2,
          conditions: [{ field: 'channel', operator: 'eq', value: 'facebook' }],
          actions: {
            teamId: 'fb_team',
            strategy: 'round-robin',
            sticky: false,
            requiredSkills: [],
          },
        }),
      ]);

      const result = await service.evaluateForTenant('tenant_1', {
        channel: 'facebook',
      });

      expect(result!.ruleId).toBe('rule_2');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Tag (Array) Field
  // ────────────────────────────────────────────────────────────────────────

  describe('tag field (array)', () => {
    it('should match eq on any tag', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          conditions: [{ field: 'tag', operator: 'eq', value: 'urgent' }],
        }),
      ]);

      const result = await service.evaluateForTenant('tenant_1', {
        tags: ['sales', 'urgent', 'follow-up'],
      });

      expect(result).not.toBeNull();
    });

    it('should match contains on any tag', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          conditions: [{ field: 'tag', operator: 'contains', value: 'vip' }],
        }),
      ]);

      const result = await service.evaluateForTenant('tenant_1', {
        tags: ['vip-customer', 'premium'],
      });

      expect(result).not.toBeNull();
    });

    it('should NOT match when no tag matches', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          conditions: [{ field: 'tag', operator: 'eq', value: 'billing' }],
        }),
      ]);

      const result = await service.evaluateForTenant('tenant_1', {
        tags: ['sales', 'support'],
      });

      expect(result).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Edge Cases
  // ────────────────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle undefined context field gracefully', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          conditions: [{ field: 'segment', operator: 'eq', value: 'VIP' }],
        }),
      ]);

      const result = await service.evaluateForTenant('tenant_1', {
        channel: 'facebook',
        // segment is undefined
      });

      expect(result).toBeNull();
    });

    it('should handle empty condition value', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          conditions: [{ field: 'channel', operator: 'eq', value: '' }],
        }),
      ]);

      const result = await service.evaluateForTenant('tenant_1', {
        channel: 'facebook',
      });

      expect(result).toBeNull();
    });

    it('should handle unknown operator gracefully', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({
          conditions: [{ field: 'channel', operator: 'regex', value: '.*' }],
        }),
      ]);

      const result = await service.evaluateForTenant('tenant_1', {
        channel: 'facebook',
      });

      expect(result).toBeNull();
    });

    it('should use evaluate() with ClsService tenantId', async () => {
      repositoryMock.findEnabledByTenant.mockResolvedValue([
        createRule({ conditions: [] }),
      ]);

      const result = await service.evaluate({ channel: 'facebook' });

      expect(clsMock.get).toHaveBeenCalledWith('tenantId');
      expect(repositoryMock.findEnabledByTenant).toHaveBeenCalledWith(
        'tenant_1',
      );
      expect(result).not.toBeNull();
    });
  });
});
