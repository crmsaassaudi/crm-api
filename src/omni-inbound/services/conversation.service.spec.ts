import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getQueueToken } from '@nestjs/bullmq';
import { ConversationService } from './conversation.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { MediaProxyService } from './media-proxy.service';
import { IdentityService } from './identity.service';
import { RedisLockService } from '../../redis/redis-lock.service';
import { ContactsService } from '../../contacts/contacts.service';
import { FacebookAdapter } from '../adapters/facebook.adapter';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { TenantsService } from '../../tenants/tenants.service';
import { OmniPayload } from '../domain/omni-payload';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { BusinessHoursService } from './business-hours.service';
import { AutoResolveService } from './auto-resolve.service';
import { OMNI_MEDIA_CACHE_QUEUE } from '../queue/omni-media-queue.constants';

describe('ConversationService Concurrency', () => {
  let service: ConversationService;
  let redisMock: any;
  let lockServiceMock: any;
  let identityServiceMock: any;
  let conversationRepoMock: any;
  let messageRepoMock: any;
  let contactsServiceMock: any;

  beforeEach(async () => {
    // Mock Redis for idempotency check
    redisMock = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
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
    };

    // Mock Repositories
    conversationRepoMock = {
      create: jest.fn().mockResolvedValue({ id: 'conv_123' }),
      updateLastMessage: jest.fn().mockResolvedValue(undefined),
      updateLastCustomerMessageAt: jest.fn().mockResolvedValue(undefined),
      findLastByExternalId: jest.fn().mockResolvedValue(null),
      findById: jest.fn().mockResolvedValue(null),
    };

    messageRepoMock = {
      create: jest.fn().mockResolvedValue({ id: 'msg_123' }),
    };

    contactsServiceMock = {
      create: jest.fn().mockResolvedValue({ id: 'contact_123' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationService,
        { provide: ConversationRepository, useValue: conversationRepoMock },
        { provide: MessageRepository, useValue: messageRepoMock },
        { provide: MediaProxyService, useValue: {} },
        { provide: IdentityService, useValue: identityServiceMock },
        { provide: RedisLockService, useValue: lockServiceMock },
        { provide: ContactsService, useValue: contactsServiceMock },
        {
          provide: FacebookAdapter,
          useValue: {
            enrichProfile: jest.fn().mockResolvedValue({ name: 'Test User' }),
          },
        },
        {
          provide: TenantsService,
          useValue: {
            findById: jest.fn().mockResolvedValue({ ownerId: 'owner_1' }),
          },
        },
        {
          provide: CrmSettingsService,
          useValue: {
            getSetting: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: BusinessHoursService,
          useValue: {
            isWithinBusinessHours: jest.fn().mockResolvedValue(true),
            getOOOConfig: jest.fn().mockResolvedValue({
              oooAutoReplyEnabled: false,
            }),
            getChannelOOOMessage: jest.fn().mockReturnValue(''),
          },
        },
        {
          provide: AutoResolveService,
          useValue: {
            scheduleAutoResolve: jest.fn().mockResolvedValue(undefined),
            rescheduleAutoResolve: jest.fn().mockResolvedValue(undefined),
            cancelAutoResolve: jest.fn().mockResolvedValue(undefined),
          },
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

    expect(redisMock.get).toHaveBeenCalledWith(
      'omni:processed:tenant_1:msg_001',
    );
    expect(lockServiceMock.acquire).toHaveBeenCalledWith(
      'lock:omni:sender:user_1',
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
    expect(messageRepoMock.create).toHaveBeenCalled();
    expect(redisMock.set).toHaveBeenCalledWith(
      'omni:processed:tenant_1:msg_001',
      '1',
      'EX',
      3600,
    );
  });

  it('should skip processing if idempotency check returns true in Redis', async () => {
    redisMock.get.mockResolvedValueOnce('1'); // already processed

    const payload = createPayload('msg_001');
    await service.handleInboundMessage(payload);

    expect(redisMock.get).toHaveBeenCalledWith(
      'omni:processed:tenant_1:msg_001',
    );
    expect(lockServiceMock.acquire).not.toHaveBeenCalled();
    expect(conversationRepoMock.create).not.toHaveBeenCalled();
    expect(messageRepoMock.create).not.toHaveBeenCalled();
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
    });

    const payload = createPayload('msg_002');
    await service.handleInboundMessage(payload);

    expect(conversationRepoMock.create).not.toHaveBeenCalled(); // No creation
    expect(messageRepoMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'existing_conv_456' }),
    );
  });
});
