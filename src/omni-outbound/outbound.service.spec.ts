import { OutboundService } from './outbound.service';
import { ReplyWindowExpiredException } from './exceptions/reply-window-expired.exception';
import { createEventBusMock } from '../test/mocks/event-bus.mock';

/**
 * OutboundService unit tests — Phase 2: Omni Realtime Risk
 *
 * Focus areas:
 * - Idempotency: duplicate send prevention via Redis NX lock + DB lookup
 * - Reply window enforcement: platform-specific 24h windows
 * - Provider failure: status rollback, Redis lock cleanup
 * - Source normalization: 'outbound' → 'agent_ui', etc.
 *
 * Note: Tests verify the actual branching logic in outbound.service.ts,
 * not abstract "should work" assertions. Each mock setup matches the
 * real call sequence of the production code.
 */
describe('OutboundService', () => {
  let service: OutboundService;
  let messageRepo: any;
  let conversationRepo: any;
  let channelRepo: any;
  let eventEmitter: ReturnType<typeof createEventBusMock>;
  let adapters: Map<string, any>;
  let redis: any;
  let usersService: any;

  const replyWindowCfg = {
    facebook: 24,
    zalo: 24,
    whatsapp: 24,
    instagram: 24,
    livechat: 0,
  };

  const baseConversation = {
    id: 'conv_1',
    channelId: 'channel_1',
    channelType: 'facebook',
    customer: { externalId: 'psid_123' },
    lastCustomerMessageAt: new Date(Date.now() - 1000 * 60 * 30), // 30 min ago → within 24h window
  };

  const baseSendParams = {
    tenantId: 'tenant_1',
    conversationId: 'conv_1',
    agentId: 'agent_1',
    content: 'Hello customer',
    messageType: 'text',
    source: 'agent_ui',
  };

  beforeEach(() => {
    messageRepo = {
      create: jest.fn().mockResolvedValue({
        id: 'msg_new',
        status: 'sending',
        senderId: 'agent_1',
      }),
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };

    conversationRepo = {
      findById: jest.fn().mockResolvedValue(baseConversation),
      updateLastMessage: jest.fn().mockResolvedValue(undefined),
    };

    channelRepo = {
      findByIdWithCredentials: jest.fn().mockResolvedValue({
        id: 'channel_1',
        credentials: { accessToken: 'tok' },
        account: 'page_1',
      }),
      findByAccountWithCredentials: jest.fn().mockResolvedValue(null),
    };

    eventEmitter = createEventBusMock();

    const facebookAdapter = {
      send: jest.fn().mockResolvedValue({ message_id: 'ext_mid_1' }),
      sendMedia: jest
        .fn()
        .mockResolvedValue({ success: true, externalMessageId: 'ext_mid_1' }),
    };
    adapters = new Map([['facebook', facebookAdapter]]);

    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    usersService = {
      findByIdsGlobal: jest.fn().mockResolvedValue([
        {
          firstName: 'John',
          lastName: 'Agent',
          email: 'agent@test.com',
          photo: null,
        },
      ]),
    };

    service = new OutboundService(
      messageRepo,
      conversationRepo,
      channelRepo,
      eventEmitter as any,
      adapters as any,
      replyWindowCfg as any,
      {} as any, // transportPool
      {} as any, // outboundQueue
      {} as any, // emailSignatureService
      usersService,
      {} as any, // emailContentModel
      {} as any, // emailMetadataModel
      redis,
      {} as any, // filesService
      {} as any, // imageProcessingService
      {} as any, // mediaHandler
      {} as any, // emailHandler
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  // HAPPY PATH — successful send
  // ═══════════════════════════════════════════════════════════════════
  describe('sendAgentMessage — happy path', () => {
    it('should persist message, send via adapter, update status to sent', async () => {
      const result = await service.sendAgentMessage(baseSendParams);

      // 1. Message persisted with status 'sending'
      expect(messageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant_1',
          conversationId: 'conv_1',
          senderId: 'agent_1',
          direction: 'outbound',
          status: 'sending',
          content: 'Hello customer',
        }),
      );
      // 2. Adapter called with correct params
      expect(adapters.get('facebook')!.send).toHaveBeenCalledWith(
        'psid_123', // customer externalId
        'Hello customer',
        'text',
        expect.objectContaining({ credentials: { accessToken: 'tok' } }),
      );
      // 3. Status updated to 'sent' with external ID
      expect(messageRepo.updateStatus).toHaveBeenCalledWith(
        'msg_new',
        'sent',
        'ext_mid_1',
      );
      // 4. Event emitted
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'omni.message.sent',
        expect.objectContaining({
          tenantId: 'tenant_1',
          conversationId: 'conv_1',
          status: 'sent',
          externalMessageId: 'ext_mid_1',
        }),
      );
      // 5. Return OK
      expect(result.ok).toBe(true);
      expect(result.status).toBe('sent');
    });

    it('should update conversation lastMessage summary', async () => {
      await service.sendAgentMessage(baseSendParams);

      expect(conversationRepo.updateLastMessage).toHaveBeenCalledWith(
        'conv_1',
        'Hello customer',
        expect.any(Date),
        'agent',
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // IDEMPOTENCY — duplicate send prevention
  // ═══════════════════════════════════════════════════════════════════
  describe('sendAgentMessage — idempotency', () => {
    it('should return existing message when idempotencyKey matches a non-failed message', async () => {
      // Simulate: DB already has a 'sent' message with this key
      messageRepo.findByIdempotencyKey.mockResolvedValueOnce({
        id: 'msg_existing',
        externalMessageId: 'ext_existing',
        status: 'sent',
        clientMessageId: 'client_1',
        senderId: 'agent_1',
        senderName: 'John Agent',
        source: 'agent_ui',
      });

      const result = await service.sendAgentMessage({
        ...baseSendParams,
        idempotencyKey: 'idem_123',
      });

      // Should NOT create a new message
      expect(messageRepo.create).not.toHaveBeenCalled();
      // Should NOT call adapter
      expect(adapters.get('facebook')!.send).not.toHaveBeenCalled();
      // Should return the existing message with reused flag
      expect(result.ok).toBe(true);
      expect(result.messageId).toBe('msg_existing');
      expect(result.reused).toBe(true);
      expect(result.status).toBe('sent');
    });

    it('should retry a failed message with same idempotencyKey', async () => {
      // DB has a 'failed' message — should retry instead of create new
      const failedMsg = {
        id: 'msg_failed',
        status: 'failed',
        senderId: 'agent_1',
        senderName: 'John Agent',
        source: 'agent_ui',
      };
      messageRepo.findByIdempotencyKey.mockResolvedValueOnce(failedMsg);

      const result = await service.sendAgentMessage({
        ...baseSendParams,
        idempotencyKey: 'idem_456',
      });

      // Should NOT create a new message (reuse existing)
      expect(messageRepo.create).not.toHaveBeenCalled();
      // Should update status to 'sending' for the retry
      expect(messageRepo.updateStatus).toHaveBeenCalledWith(
        'msg_failed',
        'sending',
      );
      // Should call adapter (actual send)
      expect(adapters.get('facebook')!.send).toHaveBeenCalled();
      // Should update to 'sent'
      expect(result.ok).toBe(true);
      expect(result.status).toBe('sent');
    });

    it('should use Redis NX lock to prevent concurrent duplicate sends', async () => {
      // First call reserves the lock (NX returns 'OK')
      redis.set.mockResolvedValueOnce('OK');

      await service.sendAgentMessage({
        ...baseSendParams,
        idempotencyKey: 'idem_concurrent',
      });

      // Redis SET with NX called
      expect(redis.set).toHaveBeenCalledWith(
        'omni:outbound:idempotency:tenant_1:idem_concurrent',
        'processing',
        'EX',
        86400,
        'NX',
      );
    });

    it('should handle Mongo duplicate key (11000) by returning existing message', async () => {
      // Redis lock succeeds, but Mongo create throws duplicate key
      redis.set.mockResolvedValueOnce('OK');
      const duplicateError = new Error('duplicate key');
      (duplicateError as any).code = 11000;
      messageRepo.create.mockRejectedValueOnce(duplicateError);
      messageRepo.findByIdempotencyKey
        .mockResolvedValueOnce(null) // first check
        .mockResolvedValueOnce({
          // recovery check after 11000
          id: 'msg_concurrent_winner',
          status: 'sent',
          senderId: 'agent_1',
          senderName: 'John Agent',
          source: 'agent_ui',
        });

      const result = await service.sendAgentMessage({
        ...baseSendParams,
        idempotencyKey: 'idem_race',
      });

      expect(result.ok).toBe(true);
      expect(result.messageId).toBe('msg_concurrent_winner');
      expect(result.reused).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // REPLY WINDOW — platform-specific enforcement
  // ═══════════════════════════════════════════════════════════════════
  describe('sendAgentMessage — reply window', () => {
    it('should throw ReplyWindowExpiredException when window is expired', async () => {
      // Customer last message was 25 hours ago → beyond 24h Facebook window
      conversationRepo.findById.mockResolvedValueOnce({
        ...baseConversation,
        lastCustomerMessageAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      });

      await expect(service.sendAgentMessage(baseSendParams)).rejects.toThrow(
        ReplyWindowExpiredException,
      );

      // Should NOT persist or send
      expect(messageRepo.create).not.toHaveBeenCalled();
      expect(adapters.get('facebook')!.send).not.toHaveBeenCalled();
    });

    it('should allow sending within reply window', async () => {
      // Customer last message was 1 hour ago → within 24h window
      conversationRepo.findById.mockResolvedValueOnce({
        ...baseConversation,
        lastCustomerMessageAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      });

      const result = await service.sendAgentMessage(baseSendParams);
      expect(result.ok).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // REPLY WINDOW STATUS — getReplyWindowStatus
  // ═══════════════════════════════════════════════════════════════════
  describe('getReplyWindowStatus', () => {
    it('should report window open when within 24h for Facebook', () => {
      const status = service.getReplyWindowStatus({
        channelType: 'facebook',
        lastCustomerMessageAt: new Date(Date.now() - 12 * 60 * 60 * 1000), // 12h ago
      });

      expect(status.isOpen).toBe(true);
      expect(status.windowHours).toBe(24);
      expect(status.remainingMs).toBeGreaterThan(0);
    });

    it('should report window closed when beyond 24h for Facebook', () => {
      const status = service.getReplyWindowStatus({
        channelType: 'facebook',
        lastCustomerMessageAt: new Date(Date.now() - 30 * 60 * 60 * 1000), // 30h ago
      });

      expect(status.isOpen).toBe(false);
      expect(status.remainingMs).toBe(0);
    });

    it('should always be open for LiveChat (windowHours=0)', () => {
      const status = service.getReplyWindowStatus({
        channelType: 'livechat',
        lastCustomerMessageAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 365), // 1 year ago
      });

      expect(status.isOpen).toBe(true);
      expect(status.windowHours).toBe(0);
      expect(status.remainingMs).toBe(Infinity);
    });

    it('should be closed when no customer message exists', () => {
      const status = service.getReplyWindowStatus({
        channelType: 'facebook',
        lastCustomerMessageAt: null,
      });

      expect(status.isOpen).toBe(false);
      expect(status.remainingMs).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PROVIDER FAILURE — status rollback + Redis cleanup
  // ═══════════════════════════════════════════════════════════════════
  describe('sendAgentMessage — provider failure', () => {
    it('should mark message as failed when adapter throws', async () => {
      adapters
        .get('facebook')!
        .send.mockRejectedValueOnce(new Error('Facebook API error 190'));

      await expect(service.sendAgentMessage(baseSendParams)).rejects.toThrow(
        'Facebook API error 190',
      );

      // Message was created, then marked failed
      expect(messageRepo.create).toHaveBeenCalled();
      expect(messageRepo.updateStatus).toHaveBeenCalledWith(
        'msg_new',
        'failed',
      );
    });

    it('should release Redis idempotency lock when adapter fails', async () => {
      redis.set.mockResolvedValueOnce('OK'); // Lock acquired
      adapters
        .get('facebook')!
        .send.mockRejectedValueOnce(new Error('Network timeout'));

      await expect(
        service.sendAgentMessage({
          ...baseSendParams,
          idempotencyKey: 'idem_fail',
        }),
      ).rejects.toThrow('Network timeout');

      // Redis lock should be released so retry can re-acquire
      expect(redis.del).toHaveBeenCalledWith(
        'omni:outbound:idempotency:tenant_1:idem_fail',
      );
    });

    it('should NOT emit omni.message.sent event when adapter fails', async () => {
      adapters
        .get('facebook')!
        .send.mockRejectedValueOnce(new Error('API down'));

      try {
        await service.sendAgentMessage(baseSendParams);
      } catch {}

      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'omni.message.sent',
        expect.anything(),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // MISSING CONVERSATION / CHANNEL
  // ═══════════════════════════════════════════════════════════════════
  describe('sendAgentMessage — missing entities', () => {
    it('should throw when conversation not found', async () => {
      conversationRepo.findById.mockResolvedValueOnce(null);

      await expect(service.sendAgentMessage(baseSendParams)).rejects.toThrow(
        'Conversation conv_1 not found',
      );
    });

    it('should throw when channel not found', async () => {
      channelRepo.findByIdWithCredentials.mockResolvedValueOnce(null);

      await expect(service.sendAgentMessage(baseSendParams)).rejects.toThrow(
        /not found or disconnected/,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // BOT MESSAGE — idempotency
  // ═══════════════════════════════════════════════════════════════════
  describe('sendBotMessage — idempotency', () => {
    it('should return existing bot message when idempotencyKey matches', async () => {
      messageRepo.findByIdempotencyKey.mockResolvedValueOnce({
        id: 'bot_msg_existing',
        externalMessageId: 'ext_bot_1',
        status: 'sent',
      });

      const result = await service.sendBotMessage({
        tenantId: 'tenant_1',
        conversationId: 'conv_1',
        content: 'Hi from bot',
        idempotencyKey: 'bot_idem_1',
      });

      expect(result.ok).toBe(true);
      expect(result.reused).toBe(true);
      expect(result.messageId).toBe('bot_msg_existing');
      expect(messageRepo.create).not.toHaveBeenCalled();
    });

    it('should handle Mongo 11000 for bot messages', async () => {
      const duplicateError = new Error('duplicate key');
      (duplicateError as any).code = 11000;
      messageRepo.create.mockRejectedValueOnce(duplicateError);
      messageRepo.findByIdempotencyKey
        .mockResolvedValueOnce(null) // first check
        .mockResolvedValueOnce({
          // recovery
          id: 'bot_msg_winner',
          status: 'sending',
        });

      const result = await service.sendBotMessage({
        tenantId: 'tenant_1',
        conversationId: 'conv_1',
        content: 'Hi from bot',
        idempotencyKey: 'bot_idem_race',
      });

      expect(result.ok).toBe(true);
      expect(result.reused).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// normalizeOutboundSource — pure function
// ═══════════════════════════════════════════════════════════════════
describe('normalizeOutboundSource (via sendAgentMessage)', () => {
  // We test source normalization through the service since the function
  // is module-private. The persisted message.source shows the normalized value.
  let service: OutboundService;
  let messageRepo: any;
  let conversationRepo: any;
  let channelRepo: any;
  let redis: any;

  const conversation = {
    id: 'conv_1',
    channelId: 'channel_1',
    channelType: 'livechat',
    customer: { externalId: 'cust_1' },
    lastCustomerMessageAt: new Date(),
  };

  beforeEach(() => {
    messageRepo = {
      create: jest.fn().mockResolvedValue({ id: 'msg', status: 'sending' }),
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
      updateStatus: jest.fn(),
    };
    conversationRepo = {
      findById: jest.fn().mockResolvedValue(conversation),
      updateLastMessage: jest.fn(),
    };
    channelRepo = {
      findByIdWithCredentials: jest.fn().mockResolvedValue({
        id: 'ch',
        credentials: {},
        account: 'acc',
      }),
      findByAccountWithCredentials: jest.fn().mockResolvedValue(null),
    };
    redis = { set: jest.fn().mockResolvedValue('OK'), del: jest.fn() };
    const usersService = {
      findByIdsGlobal: jest
        .fn()
        .mockResolvedValue([{ firstName: 'A', lastName: 'B', email: 'a@b.c' }]),
    };

    service = new OutboundService(
      messageRepo,
      conversationRepo,
      channelRepo,
      createEventBusMock() as any,
      new Map([
        ['livechat', { send: jest.fn().mockResolvedValue({ id: 'ext' }) }],
      ]) as any,
      {
        facebook: 24,
        zalo: 24,
        whatsapp: 24,
        instagram: 24,
        livechat: 0,
      } as any,
      {} as any,
      {} as any,
      {} as any,
      usersService,
      {} as any,
      {} as any,
      redis,
      {} as any,
      {} as any,
      {} as any, // mediaHandler
      {} as any, // emailHandler
    );
  });

  it.each([
    ['outbound', 'agent_ui'],
    ['socket', 'agent_ui'],
    ['api', 'crm_api'],
    ['http', 'crm_api'],
    ['', 'crm_api'],
    ['custom_source', 'custom_source'],
  ])('should normalize source "%s" → "%s"', async (input, expected) => {
    await service.sendAgentMessage({
      tenantId: 'tenant_1',
      conversationId: 'conv_1',
      agentId: 'agent_1',
      content: 'test',
      source: input,
    });

    expect(messageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ source: expected }),
    );
  });
});
