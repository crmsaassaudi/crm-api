import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { LeadScoringService, LeadScoringRule } from './lead-scoring.service';
import { LeadScoringRuleSchemaClass } from './lead-scoring-rule.schema';
import { LeadScoringConfigSchemaClass } from './lead-scoring-config.schema';
import { ContactSchemaClass } from '../contacts/infrastructure/persistence/document/entities/contact.schema';
import { ContactRepository } from '../contacts/infrastructure/persistence/document/repositories/contact.repository';

describe('LeadScoringService', () => {
  let service: LeadScoringService;
  let ruleModel: any;
  let contactModel: any;

  const mockRuleModel = {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    deleteOne: jest.fn(),
    bulkWrite: jest.fn(),
  };

  const mockConfigModel = {
    findOne: jest.fn(),
    create: jest.fn(),
    findOneAndUpdate: jest.fn(),
  };

  const mockContactModel = {
    find: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
    bulkWrite: jest.fn(),
  };

  const mockContactRepository = {};
  const mockClsService = {
    get: jest.fn().mockReturnValue('tenant-123'),
  };
  const mockEventEmitter = { emit: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LeadScoringService,
        {
          provide: getModelToken(LeadScoringRuleSchemaClass.name),
          useValue: mockRuleModel,
        },
        {
          provide: getModelToken(LeadScoringConfigSchemaClass.name),
          useValue: mockConfigModel,
        },
        {
          provide: getModelToken(ContactSchemaClass.name),
          useValue: mockContactModel,
        },
        {
          provide: ContactRepository,
          useValue: mockContactRepository,
        },
        {
          provide: ClsService,
          useValue: mockClsService,
        },
        {
          provide: EventEmitter2,
          useValue: mockEventEmitter,
        },
      ],
    }).compile();

    service = module.get<LeadScoringService>(LeadScoringService);
    ruleModel = module.get(getModelToken(LeadScoringRuleSchemaClass.name));
    contactModel = module.get(getModelToken(ContactSchemaClass.name));
  });

  describe('computeScore', () => {
    it('should compute score based on matching rules and floor total at 0', () => {
      const rules: LeadScoringRule[] = [
        {
          condition: { field: 'emails', operator: 'exists' },
          points: 10,
        },
        {
          condition: { field: 'country', operator: 'equals', value: 'VN' },
          points: 20,
        },
        {
          condition: {
            field: 'customFields',
            operator: 'equals',
            value: 'VIP',
            customFieldKey: 'tier',
          },
          points: 50,
        },
        {
          condition: { field: 'companyName', operator: 'exists' },
          points: -100, // Negative penalty
        },
      ];

      const contact = {
        emails: ['test@example.com'],
        country: 'VN',
        companyName: 'Acme Corp',
        customFields: { tier: 'VIP' },
      };

      // Matched: email (+10), country (+20), customFields (+50), companyName (-100)
      // Net sum: 10 + 20 + 50 - 100 = -20 => Floored at 0
      const score = service.computeScore(rules, contact);
      expect(score).toBe(0);
    });

    it('should compute positive score correctly', () => {
      const rules: LeadScoringRule[] = [
        {
          condition: { field: 'emails', operator: 'contains', value: '@enterprise.com' },
          points: 30,
        },
        {
          condition: { field: 'score', operator: 'greater_than', value: 5 },
          points: 15,
        },
      ];

      const contact = {
        emails: ['ceo@enterprise.com'],
        score: 10,
      };

      const score = service.computeScore(rules, contact);
      expect(score).toBe(45);
    });

    it('should evaluate activity.type condition correctly', () => {
      const rules: LeadScoringRule[] = [
        {
          condition: { field: 'activity.type', operator: 'equals', value: 'web_chat_opened' },
          points: 25,
        },
      ];

      const contact = { _id: 'c1' };
      const activityContext = { type: 'web_chat_opened' };

      const score = service.computeScore(rules, contact, activityContext);
      expect(score).toBe(25);
    });

    it('should evaluate nested AND/OR condition trees correctly', () => {
      const rules: LeadScoringRule[] = [
        {
          condition: {
            logicalOperator: 'AND',
            conditions: [
              {
                logicalOperator: 'OR',
                conditions: [
                  { field: 'country', operator: 'equals', value: 'VN' },
                  { field: 'country', operator: 'equals', value: 'SG' },
                ],
              },
              { field: 'title', operator: 'contains', value: 'CEO' },
            ],
          },
          points: 50,
        },
      ];

      const contactMatch = {
        country: 'VN',
        title: 'Chief Executive Officer (CEO)',
      };
      const contactFail = {
        country: 'US',
        title: 'CEO',
      };

      expect(service.computeScore(rules, contactMatch)).toBe(50);
      expect(service.computeScore(rules, contactFail)).toBe(0);
    });
  });

  describe('getScoreBreakdown', () => {
    it('should return matched rules and points breakdown', async () => {
      const contactId = 'contact-1';
      const tenantId = 'tenant-123';

      mockContactModel.findOne.mockReturnValue({
        lean: () => ({
          exec: jest.fn().mockResolvedValue({
            _id: contactId,
            tenantId,
            emails: ['lead@company.com'],
            score: 30,
          }),
        }),
      });

      mockRuleModel.find.mockReturnValue({
        sort: () => ({
          lean: () => ({
            exec: jest.fn().mockResolvedValue([
              {
                _id: 'r1',
                name: 'Has Email',
                points: 30,
                trigger: 'on_create',
                condition: { field: 'emails', operator: 'exists' },
              },
              {
                _id: 'r2',
                name: 'Is VIP',
                points: 50,
                trigger: 'on_update',
                condition: { field: 'isVIP', operator: 'equals', value: 'true' },
              },
            ]),
          }),
        }),
      });

      const result = await service.getScoreBreakdown(tenantId, contactId);

      expect(result.contactId).toBe(contactId);
      expect(result.score).toBe(30);
      expect(result.totalPoints).toBe(30);
      expect(result.matchedRulesCount).toBe(1);
      expect(result.matchedRules[0].name).toBe('Has Email');
    });
  });

  describe('onActivityCreated', () => {
    it('should score contact when omni.activity.created fires', async () => {
      const tenantId = 'tenant-123';
      const contactId = 'contact-88';

      mockContactModel.findOne.mockReturnValue({
        lean: () => ({
          exec: jest.fn().mockResolvedValue({
            _id: contactId,
            tenantId,
            score: 0,
          }),
        }),
      });

      mockRuleModel.find.mockReturnValue({
        setOptions: () => ({
          lean: () => ({
            exec: jest.fn().mockResolvedValue([
              {
                condition: { field: 'activity.type', operator: 'equals', value: 'inbound_message' },
                points: 10,
              },
            ]),
          }),
        }),
      });

      mockContactModel.updateOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      });

      await service.onActivityCreated({
        tenantId,
        activity: { contactId, action: 'inbound_message' },
      });

      expect(mockContactModel.updateOne).toHaveBeenCalledWith(
        { _id: contactId, tenantId },
        { $set: { score: 10 } },
      );
    });
  });

  describe('bulkRescoreForTenant', () => {
    it('should rescore all contacts in pages and bulkWrite updates', async () => {
      const tenantId = 'tenant-123';

      mockRuleModel.find.mockReturnValue({
        setOptions: () => ({
          lean: () => ({
            exec: jest.fn().mockResolvedValue([
              {
                condition: { field: 'emails', operator: 'exists' },
                points: 15,
              },
            ]),
          }),
        }),
      });

      const page1 = [
        { _id: 'c1', emails: ['a@a.com'], score: 0 },
        { _id: 'c2', emails: [], score: 15 },
      ];

      mockContactModel.find.mockReturnValue({
        sort: () => ({
          limit: () => ({
            lean: () => ({
              exec: jest.fn().mockResolvedValue(page1),
            }),
          }),
        }),
      });

      mockContactModel.bulkWrite.mockResolvedValue({ modifiedCount: 1 });

      const result = await service.bulkRescoreForTenant(tenantId);

      expect(result.scanned).toBe(2);
      expect(result.updated).toBe(1);
      expect(mockContactModel.bulkWrite).toHaveBeenCalledTimes(1);
    });
  });
});
