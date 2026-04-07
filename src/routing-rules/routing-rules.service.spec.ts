import { Test, TestingModule } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import { RoutingRulesService } from './routing-rules.service';
import { RoutingRuleRepository } from './infrastructure/persistence/document/repositories/routing-rule.repository';
import { RoutingRule } from './domain/routing-rule';

describe('RoutingRulesService', () => {
  let service: RoutingRulesService;
  let repositoryMock: any;
  let clsMock: any;

  const sampleRule = (): RoutingRule => {
    const rule = new RoutingRule();
    rule.id = 'rule_1';
    rule.name = 'Facebook Sales Rule';
    rule.enabled = true;
    rule.priority = 0;
    rule.matchType = 'all';
    rule.conditions = [{ field: 'channel', operator: 'eq', value: 'facebook' }];
    rule.actions = {
      teamId: 'sales',
      strategy: 'round-robin',
      sticky: false,
      requiredSkills: [],
    };
    return rule;
  };

  beforeEach(async () => {
    repositoryMock = {
      findAll: jest.fn().mockResolvedValue([sampleRule()]),
      findById: jest.fn().mockResolvedValue(sampleRule()),
      create: jest.fn().mockImplementation((data) => {
        const rule = new RoutingRule();
        rule.id = 'new_rule_id';
        Object.assign(rule, data);
        return Promise.resolve(rule);
      }),
      update: jest.fn().mockImplementation((tenant, id, dto) => {
        const rule = sampleRule();
        Object.assign(rule, dto);
        rule.id = id;
        return Promise.resolve(rule);
      }),
      delete: jest.fn().mockResolvedValue(true),
      reorder: jest.fn().mockResolvedValue([sampleRule()]),
      findEnabledByTenant: jest.fn().mockResolvedValue([sampleRule()]),
    };

    clsMock = {
      get: jest.fn().mockReturnValue('tenant_1'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoutingRulesService,
        { provide: RoutingRuleRepository, useValue: repositoryMock },
        { provide: ClsService, useValue: clsMock },
      ],
    }).compile();

    service = module.get<RoutingRulesService>(RoutingRulesService);
  });

  // ────────────────────────────────────────────────────────────────────────
  // CRUD Operations
  // ────────────────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it('should return all rules for current tenant', async () => {
      const result = await service.findAll();

      expect(repositoryMock.findAll).toHaveBeenCalledWith('tenant_1');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Facebook Sales Rule');
    });

    it('should return empty array when no rules exist', async () => {
      repositoryMock.findAll.mockResolvedValue([]);

      const result = await service.findAll();

      expect(result).toHaveLength(0);
    });
  });

  describe('findById', () => {
    it('should return a rule by id', async () => {
      const result = await service.findById('rule_1');

      expect(repositoryMock.findById).toHaveBeenCalledWith(
        'tenant_1',
        'rule_1',
      );
      expect(result.name).toBe('Facebook Sales Rule');
    });

    it('should throw when rule not found', async () => {
      repositoryMock.findById.mockResolvedValue(null);

      await expect(service.findById('nonexistent')).rejects.toThrow();
    });
  });

  describe('create', () => {
    it('should create a rule with proper tenant isolation', async () => {
      const dto = {
        name: 'New Rule',
        enabled: true,
        priority: 1,
        matchType: 'all' as const,
        conditions: [{ field: 'channel', operator: 'eq', value: 'zalo' }],
        actions: {
          teamId: 'support',
          strategy: 'least-busy',
          sticky: false,
          requiredSkills: [],
        },
      };

      const result = await service.create(dto);

      expect(repositoryMock.create).toHaveBeenCalledWith({
        ...dto,
        tenant: 'tenant_1',
      });
      expect(result).toBeDefined();
    });
  });

  describe('update', () => {
    it('should update an existing rule', async () => {
      const dto = {
        name: 'Updated Rule Name',
      };

      const result = await service.update('rule_1', dto);

      expect(repositoryMock.update).toHaveBeenCalledWith(
        'tenant_1',
        'rule_1',
        dto,
      );
      expect(result).toBeDefined();
    });

    it('should throw when updating non-existent rule', async () => {
      repositoryMock.update.mockResolvedValue(null);

      await expect(
        service.update('nonexistent', { name: 'x' }),
      ).rejects.toThrow();
    });
  });

  describe('delete', () => {
    it('should delete a rule', async () => {
      await service.delete('rule_1');

      expect(repositoryMock.delete).toHaveBeenCalledWith('tenant_1', 'rule_1');
    });

    it('should throw when deleting non-existent rule', async () => {
      repositoryMock.delete.mockResolvedValue(false);

      await expect(service.delete('nonexistent')).rejects.toThrow();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Reorder
  // ────────────────────────────────────────────────────────────────────────

  describe('reorder', () => {
    it('should reorder rules by ID list', async () => {
      const orderedIds = ['rule_3', 'rule_1', 'rule_2'];

      await service.reorder(orderedIds);

      expect(repositoryMock.reorder).toHaveBeenCalledWith(
        'tenant_1',
        orderedIds,
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Tenant Isolation
  // ────────────────────────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('should always pass tenantId from CLS to repository', async () => {
      await service.findAll();
      expect(repositoryMock.findAll).toHaveBeenCalledWith('tenant_1');

      await service.findById('rule_1');
      expect(repositoryMock.findById).toHaveBeenCalledWith(
        'tenant_1',
        'rule_1',
      );

      await service.create({
        name: 'X',
        enabled: true,
        priority: 0,
        matchType: 'all',
        conditions: [],
        actions: {
          teamId: '',
          strategy: 'round-robin',
          sticky: false,
          requiredSkills: [],
        },
      });
      expect(repositoryMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenant: 'tenant_1' }),
      );

      await service.delete('rule_1');
      expect(repositoryMock.delete).toHaveBeenCalledWith('tenant_1', 'rule_1');
    });

    it('should use different tenant from CLS context', async () => {
      clsMock.get.mockReturnValue('tenant_2');

      await service.findAll();

      expect(repositoryMock.findAll).toHaveBeenCalledWith('tenant_2');
    });
  });
});
