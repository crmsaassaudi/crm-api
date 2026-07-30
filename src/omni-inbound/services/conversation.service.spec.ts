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
import { ConversationLifecycleService } from './conversation-lifecycle.service';
import { ConversationCommandService } from '../aggregate/conversation-command.service';
import { ChannelRepository } from '../../channels/infrastructure/persistence/document/repositories/channel.repository';

describe('ConversationService Concurrency', () => {
  let service: ConversationService;
  let redisMock: any;
  let lockServiceMock: any;
  let identityServiceMock: any;
  let conversationRepoMock: any;
  let messageRepoMock: any;
  let orchestrationMock: any;
  let shadowContactMock: any;
  let conversationCommandMock: any;

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
      reopenConversation: jest.fn().mockResolvedValue(null),
    };

    messageRepoMock = {
      upsertInboundByExternalId: jest.fn().mockResolvedValue({
        message: { id: 'msg_123' },
        inserted: true,
      }),
    };

    // Mock InboundOrchestrationService. Only the parts of orchestration that
    // still run on the inbound path live here — bot processing, business-hours
    // and auto-resolve moved behind the command queue (ConversationOpsProcessor).
    orchestrationMock = {
      // Added when bot-first routing landed: the service asks whether the
      // channel is configured to let the bot answer before any agent is
      // assigned, and skips auto-assignment when it is.
      isBotFirstActive: jest.fn().mockResolvedValue(false),
      triggerAutoAssignment: jest.fn().mockResolvedValue(undefined),
      checkAndReassignIfNeeded: jest.fn().mockResolvedValue(undefined),
      resolveInitialBotState: jest.fn().mockResolvedValue({
        enabled: false,
        provider: 'typebot',
        flowId: null,
        sessionId: null,
        status: 'active',
        lastError: null,
      }),
      cancelAutoResolve: jest.fn().mockResolvedValue(undefined),
      releaseConversation: jest.fn().mockResolvedValue(undefined),
    };

    // Mock ShadowContactService (replaces ContactsService, TenantsService)
    shadowContactMock = {
      createShadowContact: jest.fn().mockResolvedValue('contact_123'),
      // Fills a visitor profile from an already-linked Contact. Returns the
      // enriched profile, or null when there is nothing to add — the service
      // falls back to the original profile on null, so the default here must be
      // a value the caller can use rather than undefined.
      enrichProfileFromContact: jest
        .fn()
        .mockImplementation((_contactId: string, profile: any) =>
          Promise.resolve(profile),
        ),
      getIdentityResolutionConfig: jest.fn().mockResolvedValue({
        autoCreateShadowContact: true,
        autoEnrichProfile: true,
        enrichmentDisclaimer: '',
        autoMergeShadowContact: true,
        autoMergeStrategy: 'phone_email_match',
      }),
    };

    conversationCommandMock = {
      enqueueCustomerMessage: jest.fn().mockResolvedValue(undefined),
      enqueueAssignAgent: jest.fn().mockResolvedValue(undefined),
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
        {
          provide: ConversationLifecycleService,
          useValue: {
            toSchemaChannelType: jest
              .fn()
              .mockImplementation((type: string) => type.toLowerCase()),
            getSessionLifecycleConfig: jest
              .fn()
              .mockResolvedValue({ reopenWindowHours: 24 }),
          },
        },
        { provide: IOREDIS_CLIENT, useValue: redisMock },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: getQueueToken(OMNI_MEDIA_CACHE_QUEUE),
          useValue: { add: jest.fn().mockResolvedValue({}) },
        },
        // The conversation aggregate is updated through a serialised command
        // queue rather than written directly, so the inbound path enqueues a
        // customer-message command instead of mutating the document.
        {
          provide: ConversationCommandService,
          useValue: conversationCommandMock,
        },
        {
          provide: ChannelRepository,
          useValue: {
            findById: jest
              .fn()
              .mockResolvedValue({ id: 'channel_1', inboxId: 'inbox_1' }),
          },
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
    expect(conversationRepoMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ inboxId: 'inbox_1' }),
    );
    expect(identityServiceMock.updateIdentity).toHaveBeenCalledWith(
      'facebook',
      'page_1',
      'thread_1',
      { contactId: 'contact_123', conversationId: 'conv_123' },
      'tenant_1',
    );
    // Message persistence, bot processing, business hours and auto-resolve all
    // happen in ConversationOpsProcessor now — the inbound path only enqueues
    // the CUSTOMER_MESSAGE command and hands the idempotency key over with it.
    expect(messageRepoMock.upsertInboundByExternalId).not.toHaveBeenCalled();
    expect(conversationCommandMock.enqueueCustomerMessage).toHaveBeenCalledWith(
      'conv_123',
      'tenant_1',
      payload,
      'msg_001',
      'omni:processed:tenant_1:msg_001',
    );
  });

  it('should start a new session instead of reopening a closed conversation', async () => {
    const payload = createPayload('msg_closed_001');
    identityServiceMock.resolveIdentityForTenant.mockResolvedValue({
      contactId: 'contact_123',
      conversationId: 'conv_closed',
    });
    conversationRepoMock.findById.mockResolvedValue({
      id: 'conv_closed',
      tenantId: 'tenant_1',
      contactId: 'contact_123',
      status: 'closed',
      updatedAt: new Date(),
    });
    conversationRepoMock.create.mockResolvedValue({ id: 'conv_new' });

    await service.handleInboundMessage(payload);

    expect(conversationRepoMock.reopenConversation).not.toHaveBeenCalled();
    expect(conversationRepoMock.create).toHaveBeenCalled();
    expect(identityServiceMock.updateIdentity).toHaveBeenCalledWith(
      'facebook',
      'page_1',
      'thread_1',
      { contactId: 'contact_123', conversationId: 'conv_new' },
      'tenant_1',
    );
    expect(conversationCommandMock.enqueueCustomerMessage).toHaveBeenCalledWith(
      'conv_new',
      'tenant_1',
      payload,
      'msg_closed_001',
      'omni:processed:tenant_1:msg_closed_001',
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
    );
  });

  it('should skip auto-assignment when the channel is bot-first', async () => {
    orchestrationMock.isBotFirstActive.mockResolvedValueOnce(true);

    const payload = createPayload('msg_004');

    await service.handleInboundMessage(payload);

    expect(orchestrationMock.triggerAutoAssignment).not.toHaveBeenCalled();
    expect(conversationCommandMock.enqueueCustomerMessage).toHaveBeenCalled();
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
    expect(
      conversationCommandMock.enqueueCustomerMessage,
    ).not.toHaveBeenCalled();
  });

  it('should skip processing if E11000 is thrown during save', async () => {
    // Simulate race condition where the lock was slow and another worker saved it
    lockServiceMock.acquire.mockImplementationOnce(
      (key: any, ttl: any, cb: any) => {
        void key;
        void ttl;
        void cb;
        const err = new Error('Duplicate key');
        (err as any).code = 11000;
        throw err;
      },
    );

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
    expect(conversationCommandMock.enqueueCustomerMessage).toHaveBeenCalledWith(
      'existing_conv_456',
      'tenant_1',
      payload,
      'msg_002',
      'omni:processed:tenant_1:msg_002',
    );
  });

  it('should release the idempotency key when processing fails', async () => {
    lockServiceMock.acquire.mockRejectedValueOnce(new Error('boom'));

    const payload = createPayload('msg_fail');

    await expect(service.handleInboundMessage(payload)).rejects.toThrow('boom');

    expect(redisMock.del).toHaveBeenCalledWith(
      'omni:processed:tenant_1:msg_fail',
    );
  });

  // ── Pre-identified visitor tests (pre-chat form enrichment) ──────────

  describe('pre-identified visitor flow', () => {
    it('should use enriched Contact data when identity cache has contactId but no conversationId', async () => {
      // Scenario: Visitor submitted pre-chat form → enrichment cached contactId
      // → first message arrives → conversationId is null but contactId exists
      identityServiceMock.resolveIdentityForTenant.mockResolvedValueOnce({
        contactId: 'enriched_contact_99',
        conversationId: null,
      });

      // The service asks ShadowContactService to fold the linked Contact into
      // the (empty) profile it built from the payload.
      shadowContactMock.enrichProfileFromContact.mockResolvedValueOnce({
        name: 'Nguyen Toan',
        email: 'toan@example.com',
        phone: '0901234567',
      });

      const payload = createPayload('msg_pre_identified');
      await service.handleInboundMessage(payload);

      // Should NOT create a new shadow contact
      expect(shadowContactMock.createShadowContact).not.toHaveBeenCalled();

      // Should create conversation with enriched customer data
      expect(conversationRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: 'enriched_contact_99',
          customer: expect.objectContaining({
            name: 'Nguyen Toan',
            phone: '0901234567',
            email: 'toan@example.com',
          }),
        }),
      );
    });

    it('should fall back to shadow contact when identity cache has no contactId', async () => {
      // No pre-identification — normal flow
      identityServiceMock.resolveIdentityForTenant.mockResolvedValueOnce({
        contactId: null,
        conversationId: null,
      });

      const payload = createPayload('msg_no_prechat');
      await service.handleInboundMessage(payload);

      // Should create shadow contact as usual
      expect(shadowContactMock.createShadowContact).toHaveBeenCalled();
      expect(conversationRepoMock.create).toHaveBeenCalled();
    });

    it('should populate email in conversation.customer from enriched Contact', async () => {
      identityServiceMock.resolveIdentityForTenant.mockResolvedValueOnce({
        contactId: 'contact_with_email',
        conversationId: null,
      });

      shadowContactMock.enrichProfileFromContact.mockResolvedValueOnce({
        name: 'Test User',
        email: 'test.user@company.com',
      });

      const payload = createPayload('msg_email_test');
      await service.handleInboundMessage(payload);

      expect(conversationRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: expect.objectContaining({
            email: 'test.user@company.com',
          }),
        }),
      );
    });
  });
});
