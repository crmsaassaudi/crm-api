import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getQueueToken } from '@nestjs/bullmq';
import { ConversationService } from './conversation.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { MediaProxyService } from './media-proxy.service';
import { IdentityService } from './identity.service';
import { RedisLockService } from '../../redis/redis-lock.service';
import { CHANNEL_ADAPTERS } from '../adapters/channel-adapter.interface';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { OmniPayload } from '../domain/omni-payload';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { OMNI_MEDIA_CACHE_QUEUE } from '../queue/omni-media-queue.constants';
import { InboundOrchestrationService } from './inbound-orchestration.service';
import { ShadowContactService } from './shadow-contact.service';

describe('ConversationService Concurrency', () => {
  let service: ConversationService;
  let redisMock: any;
  let lockServiceMock: any;
  let identityServiceMock: any;
  let conversationRepoMock: any;
  let messageRepoMock: any;
  let orchestrationMock: any;
  let shadowContactMock: any;

  beforeEach(async () => {
    // Mock Redis for idempotency check
    redisMock = {
      set: jest.fn().mockResolvedValue('OK'),
      expire: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
    };

    // Mock RedisLockService: execute callback immediately
    lockServiceMock = {
      acquire: jest.fn().mockImplementation((key, ttl, cb) => {
        void key;
        void ttl;
        return cb();
      }),
    };

    // Mock IdentityService
    identityServiceMock = {
      resolveIdentityForTenant: jest.fn().mockResolvedValue({
        contactId: null,
        conversationId: null,
      }),
      updateIdentity: jest.fn().mockResolvedValue(undefined),
      invalidateIdentity: jest.fn().mockResolvedValue(undefined),
    };

    // Mock Repositories
    conversationRepoMock = {
      create: jest.fn().mockResolvedValue({ id: 'conv_123' }),
      updateLastMessage: jest.fn().mockResolvedValue(undefined),
      updateLastCustomerMessageAt: jest.fn().mockResolvedValue(undefined),
      findLastByExternalId: jest.fn().mockResolvedValue(null),
      findById: jest.fn().mockResolvedValue(null),
      updateContactId: jest.fn().mockResolvedValue(undefined),
    };

    messageRepoMock = {
      upsertInboundByExternalId: jest.fn().mockResolvedValue({
        message: { id: 'msg_123' },
        inserted: true,
      }),
    };

    // Mock InboundOrchestrationService (replaces AssignmentService, BotQueueService,
    // BusinessHoursService, AutoResolveService, AgentPresenceService)
    orchestrationMock = {
      triggerAutoAssignment: jest.fn().mockResolvedValue(undefined),
      checkAndReassignIfNeeded: jest.fn().mockResolvedValue(undefined),
      resolveInitialBotState: jest.fn().mockResolvedValue({
        enabled: false,
        provider: 'typebot',
        flowId: null,
        sessionId: null,
        status: 'active',
        lastError: null,
        lockedAt: null,
      }),
      enqueueBotProcessingIfNeeded: jest.fn().mockResolvedValue(undefined),
      handleBusinessHoursCheck: jest.fn().mockResolvedValue(undefined),
      rescheduleAutoResolve: jest.fn().mockResolvedValue(undefined),
      cancelAutoResolve: jest.fn().mockResolvedValue(undefined),
      releaseConversation: jest.fn().mockResolvedValue(undefined),
    };

    // Mock ShadowContactService (replaces ContactsService, TenantsService)
    shadowContactMock = {
      createShadowContact: jest
        .fn()
        .mockResolvedValue('contact_123'),
      getIdentityResolutionConfig: jest.fn().mockResolvedValue({
        autoCreateShadowContact: true,
        autoEnrichProfile: true,
        enrichmentDisclaimer: '',
        autoMergeShadowContact: true,
        autoMergeStrategy: 'phone_email_match',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationService,
        { provide: ConversationRepository, useValue: conversationRepoMock },
        { provide: MessageRepository, useValue: messageRepoMock },
        { provide: MediaProxyService, useValue: {} },
        { provide: IdentityService, useValue: identityServiceMock },
        { provide: RedisLockService, useValue: lockServiceMock },
        {
          provide: CHANNEL_ADAPTERS,
          useValue: new Map(),
        },
        {
          provide: CrmSettingsService,
          useValue: {
            getSetting: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: InboundOrchestrationService,
          useValue: orchestrationMock,
        },
        {
          provide: ShadowContactService,
          useValue: shadowContactMock,
        },
        { provide: IOREDIS_CLIENT, useValue: redisMock },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: getQueueToken(OMNI_MEDIA_CACHE_QUEUE),
          useValue: { add: jest.fn().mockResolvedValue({}) },
        },
      ],
    }).compile();

    service = module.get<ConversationService>(ConversationService);
  });

  const createPayload = (msgId: string): OmniPayload => ({
    tenantId: 'tenant_1',
    channelId: 'channel_1',
    channelAccount: 'page_1',
    channelType: 'facebook',
    senderId: 'user_1',
    senderType: 'customer',
    messageType: 'text',
    content: 'Hello',
    metadata: {},
    externalMessageId: msgId,
    externalConversationId: 'thread_1',
    timestamp: new Date(),
    providerTimestamp: new Date(),
  });

  it('should process a message and create a conversation when not cached', async () => {
    const payload = createPayload('msg_001');

    await service.handleInboundMessage(payload);

    expect(redisMock.set).toHaveBeenCalledWith(
      'omni:processed:tenant_1:msg_001',
      '1',
      'EX',
      3600,
      'NX',
    );
    expect(lockServiceMock.acquire).toHaveBeenCalledWith(
      'lock:inbound:tenant_1:channel_1:user_1',
      5000,
      expect.any(Function),
    );
    expect(identityServiceMock.resolveIdentityForTenant).toHaveBeenCalled();
    expect(conversationRepoMock.create).toHaveBeenCalled();
    expect(identityServiceMock.updateIdentity).toHaveBeenCalledWith(
      'facebook',
      'page_1',
      'thread_1',
      { contactId: 'contact_123', conversationId: 'conv_123' },
      'tenant_1',
    );
    expect(messageRepoMock.upsertInboundByExternalId).toHaveBeenCalled();
    expect(redisMock.expire).toHaveBeenCalledWith(
      'omni:processed:tenant_1:msg_001',
      3600,
    );
  });

  it('should delegate to orchestration for auto-assignment on new conversation', async () => {
    const payload = createPayload('msg_003');

    await service.handleInboundMessage(payload);

    expect(orchestrationMock.triggerAutoAssignment).toHaveBeenCalledWith(
      payload,
      'conv_123',
      'contact_123',
      'new_conversation',
      expect.any(Object),
    );
  });

  it('should delegate to orchestration for bot processing', async () => {
    const payload = createPayload('msg_004');

    await service.handleInboundMessage(payload);

    expect(
      orchestrationMock.enqueueBotProcessingIfNeeded,
    ).toHaveBeenCalledWith(payload, 'conv_123', 'msg_123');
  });

  it('should delegate to orchestration for business hours check', async () => {
    const payload = createPayload('msg_005');

    await service.handleInboundMessage(payload);

    expect(orchestrationMock.handleBusinessHoursCheck).toHaveBeenCalledWith(
      payload,
      'conv_123',
    );
  });

  it('should delegate to orchestration for auto-resolve scheduling', async () => {
    const payload = createPayload('msg_006');

    await service.handleInboundMessage(payload);

    // Called twice: once for new conversation schedule, once for message reschedule
    expect(orchestrationMock.rescheduleAutoResolve).toHaveBeenCalledTimes(2);
  });

  it('should delegate to shadowContactService for contact creation', async () => {
    const payload = createPayload('msg_007');

    await service.handleInboundMessage(payload);

    expect(shadowContactMock.createShadowContact).toHaveBeenCalledWith(
      payload,
      expect.any(Object),
    );
  });

  it('should skip processing if idempotency check returns true in Redis', async () => {
    redisMock.set.mockResolvedValueOnce(null); // already processed

    const payload = createPayload('msg_001');
    await service.handleInboundMessage(payload);

    expect(redisMock.set).toHaveBeenCalledWith(
      'omni:processed:tenant_1:msg_001',
      '1',
      'EX',
      3600,
      'NX',
    );
    expect(lockServiceMock.acquire).not.toHaveBeenCalled();
    expect(conversationRepoMock.create).not.toHaveBeenCalled();
    expect(messageRepoMock.upsertInboundByExternalId).not.toHaveBeenCalled();
  });

  it('should skip processing if E11000 is thrown during save', async () => {
    // Simulate race condition where the lock was slow and another worker saved it
    lockServiceMock.acquire.mockImplementationOnce((key, ttl, cb) => {
      void key;
      void ttl;
      void cb;
      const err = new Error('Duplicate key');
      (err as any).code = 11000;
      throw err;
    });

    const payload = createPayload('msg_001');
    await service.handleInboundMessage(payload);

    // Should catch the error and return peacefully
    expect(lockServiceMock.acquire).toHaveBeenCalled();
    expect(conversationRepoMock.create).not.toHaveBeenCalled();
  });

  it('should use existing conversation from identity cache', async () => {
    // Mock that we found the identity in cache
    identityServiceMock.resolveIdentityForTenant.mockResolvedValueOnce({
      contactId: 'user_1',
      conversationId: 'existing_conv_456',
    });

    // Mock findById to return the existing active conversation
    conversationRepoMock.findById.mockResolvedValueOnce({
      id: 'existing_conv_456',
      tenantId: 'tenant_1',
      status: 'open',
      contactId: 'user_1',
      assignedAgentId: 'agent_1',
    });

    const payload = createPayload('msg_002');
    await service.handleInboundMessage(payload);

    expect(conversationRepoMock.create).not.toHaveBeenCalled(); // No creation
    expect(messageRepoMock.upsertInboundByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'existing_conv_456' }),
    );
  });

  it('should skip duplicate side effects when inbound upsert finds existing message', async () => {
    messageRepoMock.upsertInboundByExternalId.mockResolvedValueOnce({
      message: { id: 'msg_existing' },
      inserted: false,
    });

    const eventEmitter = (service as any).eventEmitter;
    const payload = createPayload('msg_duplicate');

    await service.handleInboundMessage(payload);

    expect(messageRepoMock.upsertInboundByExternalId).toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalledWith(
      'omni.message.persisted',
      expect.anything(),
    );
  });
});
