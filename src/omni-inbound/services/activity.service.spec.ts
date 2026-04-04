import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ActivityService } from './activity.service';
import { ActivityRepository } from '../repositories/activity.repository';
import { UsersService } from '../../users/users.service';

describe('ActivityService', () => {
  let service: ActivityService;
  let activityRepo: jest.Mocked<ActivityRepository>;
  let eventEmitter: jest.Mocked<EventEmitter2>;
  let usersService: jest.Mocked<UsersService>;

  const mockActivity = {
    id: 'act-1',
    tenantId: 'tenant-1',
    conversationId: 'conv-1',
    actorType: 'system',
    actorId: null,
    action: 'conversation_created',
    oldValue: null,
    newValue: 'open',
    metadata: {},
    description: 'Cuộc hội thoại mới từ kênh Facebook Messenger',
    createdAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActivityService,
        {
          provide: ActivityRepository,
          useValue: {
            create: jest.fn().mockResolvedValue(mockActivity),
            findByConversation: jest.fn().mockResolvedValue({
              data: [mockActivity],
              total: 1,
              page: 1,
              limit: 50,
            }),
          },
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
        {
          provide: UsersService,
          useValue: {
            findByIds: jest.fn().mockResolvedValue([
              {
                id: 'agent-1',
                firstName: 'Nguyễn',
                lastName: 'Văn A',
                email: 'a@test.com',
              },
            ]),
          },
        },
      ],
    }).compile();

    service = module.get<ActivityService>(ActivityService);
    activityRepo = module.get(ActivityRepository);
    eventEmitter = module.get(EventEmitter2);
    usersService = module.get(UsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─── getActivities ───────────────────────────────────────────────

  describe('getActivities', () => {
    it('should delegate to repository', async () => {
      const result = await service.getActivities('conv-1', 1, 50);
      expect(activityRepo.findByConversation).toHaveBeenCalledWith(
        'conv-1',
        1,
        50,
      );
      expect(result.data).toHaveLength(1);
    });
  });

  // ─── onConversationCreated ────────────────────────────────────────

  describe('onConversationCreated', () => {
    it('should log with correct description including channel name', async () => {
      await service.onConversationCreated({
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        channelType: 'facebook',
        senderId: 'sender-1',
      });

      expect(activityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'conversation_created',
          actorType: 'system',
          description: 'Cuộc hội thoại mới từ kênh Facebook Messenger',
        }),
      );
    });

    it('should emit omni.activity.created event', async () => {
      await service.onConversationCreated({
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        channelType: 'zalo',
        senderId: 'sender-1',
      });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'omni.activity.created',
        expect.objectContaining({
          tenantId: 'tenant-1',
          conversationId: 'conv-1',
        }),
      );
    });
  });

  // ─── onConversationReopened ───────────────────────────────────────

  describe('onConversationReopened', () => {
    it('should log reopened with count', async () => {
      await service.onConversationReopened({
        tenantId: 'tenant-1',
        conversationId: 'conv-2',
        previousConversationId: 'conv-1',
        reopenCount: 3,
      });

      expect(activityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'conversation_reopened',
          description: expect.stringContaining('lần thứ 3'),
        }),
      );
    });
  });

  // ─── onStatusChanged ─────────────────────────────────────────────

  describe('onStatusChanged', () => {
    it('should log agent-triggered status change with agent name', async () => {
      await service.onStatusChanged({
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        status: 'resolved',
        oldStatus: 'open',
        agentId: 'agent-1',
      });

      expect(usersService.findByIds).toHaveBeenCalledWith(['agent-1']);
      expect(activityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'status_changed',
          description: expect.stringContaining('Nguyễn Văn A'),
        }),
      );
    });

    it('should log auto-resolve as separate action', async () => {
      await service.onStatusChanged({
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        status: 'resolved',
        oldStatus: 'open',
        agentId: '',
        resolveSource: 'auto',
        reason: 'auto_resolve_idle',
      });

      expect(activityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auto_resolved',
          actorType: 'system',
          description: expect.stringContaining('tự động resolve'),
        }),
      );
    });
  });

  // ─── onAssigned ──────────────────────────────────────────────────

  describe('onAssigned', () => {
    it('should log assignment with agent name and strategy', async () => {
      await service.onAssigned({
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        agentId: 'agent-1',
        oldAgentId: null,
        strategy: 'round-robin',
      });

      expect(activityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'agent_assigned',
          description: expect.stringContaining('Nguyễn Văn A'),
        }),
      );
      expect(activityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          description: expect.stringContaining('Round-Robin'),
        }),
      );
    });

    it('should log unassignment', async () => {
      await service.onAssigned({
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        agentId: null,
        oldAgentId: 'agent-1',
      });

      expect(activityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'agent_unassigned',
          description: expect.stringContaining('gỡ khỏi'),
        }),
      );
    });
  });

  // ─── onSlaBreach ─────────────────────────────────────────────────

  describe('onSlaBreach', () => {
    it('should log SLA breach with type', async () => {
      await service.onSlaBreach({
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        slaType: 'first_response',
        deadline: '2026-04-04T10:00:00Z',
      });

      expect(activityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sla_breached',
          description: expect.stringContaining('FRT'),
        }),
      );
    });
  });

  // ─── onTicketCreated ─────────────────────────────────────────────

  describe('onTicketCreated', () => {
    it('should log ticket creation with subject', async () => {
      await service.onTicketCreated({
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        ticketId: 'ticket-1',
        subject: 'Customer complaint',
        agentId: 'agent-1',
      });

      expect(activityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ticket_created',
          description: expect.stringContaining('Customer complaint'),
        }),
      );
    });
  });

  // ─── onDealCreated ───────────────────────────────────────────────

  describe('onDealCreated', () => {
    it('should log deal creation with title', async () => {
      await service.onDealCreated({
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        dealId: 'deal-1',
        title: 'Enterprise License Q2',
        agentId: 'agent-1',
      });

      expect(activityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'deal_created',
          description: expect.stringContaining('Enterprise License Q2'),
        }),
      );
    });
  });

  // ─── Error handling ──────────────────────────────────────────────

  describe('error handling', () => {
    it('should not throw when repository create fails', async () => {
      activityRepo.create.mockRejectedValueOnce(new Error('DB error'));

      await expect(
        service.onConversationCreated({
          tenantId: 'tenant-1',
          conversationId: 'conv-1',
          channelType: 'facebook',
          senderId: 'sender-1',
        }),
      ).resolves.not.toThrow();
    });

    it('should not emit event when repository create fails', async () => {
      activityRepo.create.mockRejectedValueOnce(new Error('DB error'));

      await service.onConversationCreated({
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        channelType: 'facebook',
        senderId: 'sender-1',
      });

      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'omni.activity.created',
        expect.anything(),
      );
    });
  });

  // ─── onIdentityMerged ────────────────────────────────────────────

  describe('onIdentityMerged', () => {
    it('should skip if no conversationId', async () => {
      await service.onIdentityMerged({
        tenantId: 'tenant-1',
        existingContactId: 'contact-1',
        senderId: 'sender-1',
        channelType: 'facebook',
        matchedBy: 'phone',
      });

      expect(activityRepo.create).not.toHaveBeenCalled();
    });

    it('should log merge with channel and match type', async () => {
      await service.onIdentityMerged({
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        existingContactId: 'contact-1',
        senderId: 'sender-1',
        channelType: 'zalo',
        matchedBy: 'phone',
      });

      expect(activityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'identity_merged',
          description: expect.stringContaining('Zalo OA'),
        }),
      );
    });
  });
});
