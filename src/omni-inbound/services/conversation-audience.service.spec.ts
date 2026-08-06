import {
  ConversationAudienceService,
  redactPii,
  type SocketScope,
} from './conversation-audience.service';

const scope = (overrides: Partial<SocketScope> = {}): SocketScope => ({
  channelIds: null,
  ownerIds: null,
  includeUnowned: false,
  canUnmask: true,
  permissions: new Set<string>(),
  ...overrides,
});

/** A socket that records what it was sent. */
const socketFor = (tenantId: string, socketScope?: SocketScope) => ({
  data: { tenantId, scope: socketScope },
  emit: jest.fn(),
});

const serverWith = (sockets: any[]) =>
  ({
    sockets: { sockets: new Map(sockets.map((s, i) => [String(i), s])) },
  }) as any;

describe('ConversationAudienceService', () => {
  let conversations: any;
  let service: ConversationAudienceService;

  beforeEach(() => {
    conversations = {
      findAuthorizationFacts: jest
        .fn()
        .mockResolvedValue({ channelId: 'ch_fb', assignedAgentId: 'agent_1' }),
    };
    service = new ConversationAudienceService(conversations);
  });

  it('should not deliver a conversation on a channel the agent may not serve', async () => {
    // The channel support pool is an authorization boundary, and the socket used
    // to ignore it entirely: an agent restricted to one channel received every
    // other channel's message bodies by listening.
    const outsidePool = socketFor('t1', scope({ channelIds: ['ch_whatsapp'] }));
    const insidePool = socketFor('t1', scope({ channelIds: ['ch_fb'] }));

    await service.emitToConversation(
      serverWith([outsidePool, insidePool]),
      { tenantId: 't1', conversationId: 'c1' },
      'omni:message:new',
      { content: 'hello' },
    );

    expect(outsidePool.emit).not.toHaveBeenCalled();
    expect(insidePool.emit).toHaveBeenCalledWith('omni:message:new', {
      content: 'hello',
    });
  });

  it('should not deliver a conversation owned outside the agent scope', async () => {
    const sees = socketFor('t1', scope({ ownerIds: ['agent_1', 'agent_2'] }));
    const blind = socketFor('t1', scope({ ownerIds: ['agent_9'] }));

    await service.emitToConversation(
      serverWith([sees, blind]),
      { tenantId: 't1', conversationId: 'c1' },
      'omni:message:new',
      {},
    );

    expect(sees.emit).toHaveBeenCalled();
    expect(blind.emit).not.toHaveBeenCalled();
  });

  it('should deliver an unowned conversation only when unowned records are in scope', async () => {
    conversations.findAuthorizationFacts.mockResolvedValue({
      channelId: 'ch_fb',
      assignedAgentId: null,
    });
    const included = socketFor(
      't1',
      scope({ ownerIds: ['agent_1'], includeUnowned: true }),
    );
    const excluded = socketFor(
      't1',
      scope({ ownerIds: ['agent_1'], includeUnowned: false }),
    );

    await service.emitToConversation(
      serverWith([included, excluded]),
      { tenantId: 't1', conversationId: 'c1' },
      'omni:message:new',
      {},
    );

    expect(included.emit).toHaveBeenCalled();
    expect(excluded.emit).not.toHaveBeenCalled();
  });

  it('should redact customer PII for a socket without the unmask permission', async () => {
    const masked = socketFor('t1', scope({ canUnmask: false }));
    const unmasked = socketFor('t1', scope({ canUnmask: true }));
    const payload = {
      conversationId: 'c1',
      customer: { name: 'Sara', phone: '+966500000000', email: 'a@b.c' },
    };

    await service.emitToConversation(
      serverWith([masked, unmasked]),
      { tenantId: 't1', conversationId: 'c1' },
      'omni:conversation:new',
      payload,
    );

    // FieldMaskingInterceptor is an HTTP interceptor and cannot reach a
    // server-initiated emit, so the same phone number was masked on the REST read
    // and broadcast in clear over the socket.
    expect(masked.emit.mock.calls[0][1].customer).toEqual({
      name: 'Sara',
      phone: null,
      email: null,
    });
    expect(unmasked.emit.mock.calls[0][1].customer.phone).toBe('+966500000000');
    // The shared payload must not be mutated on the way out.
    expect(payload.customer.phone).toBe('+966500000000');
  });

  it('should deliver nothing to a socket with no resolved scope', async () => {
    const unresolved = socketFor('t1', undefined);

    await service.emitToConversation(
      serverWith([unresolved]),
      { tenantId: 't1', conversationId: 'c1' },
      'omni:message:new',
      {},
    );

    // Fail closed: an unresolved scope means we do not know what this agent may
    // see, which is not a reason to send them everything.
    expect(unresolved.emit).not.toHaveBeenCalled();
  });

  it('should never cross tenants', async () => {
    const otherTenant = socketFor('t2', scope());

    await service.emitToConversation(
      serverWith([otherTenant]),
      { tenantId: 't1', conversationId: 'c1' },
      'omni:message:new',
      {},
    );

    expect(otherTenant.emit).not.toHaveBeenCalled();
  });

  it('should read authorization facts once per conversation, then cache', async () => {
    const socket = socketFor('t1', scope());
    const server = serverWith([socket]);

    for (let i = 0; i < 3; i++) {
      await service.emitToConversation(
        server,
        { tenantId: 't1', conversationId: 'c1' },
        'omni:message:new',
        {},
      );
    }

    // One read for three messages: this sits on the inbound hot path.
    expect(conversations.findAuthorizationFacts).toHaveBeenCalledTimes(1);
  });

  it('should drop cached facts when the conversation is reassigned', async () => {
    const socket = socketFor('t1', scope());
    const server = serverWith([socket]);
    const target = { tenantId: 't1', conversationId: 'c1' };

    await service.emitToConversation(server, target, 'e', {});
    service.onAssignmentChanged({ conversationId: 'c1' });
    await service.emitToConversation(server, target, 'e', {});

    expect(conversations.findAuthorizationFacts).toHaveBeenCalledTimes(2);
  });

  it('should treat an undescribable conversation as visible only to unrestricted agents', async () => {
    conversations.findAuthorizationFacts.mockResolvedValue(null);
    const unrestricted = socketFor('t1', scope());
    const restricted = socketFor('t1', scope({ channelIds: ['ch_fb'] }));

    await service.emitToConversation(
      serverWith([unrestricted, restricted]),
      { tenantId: 't1', conversationId: 'gone' },
      'omni:message:new',
      {},
    );

    expect(unrestricted.emit).toHaveBeenCalled();
    expect(restricted.emit).not.toHaveBeenCalled();
  });

  describe('mayAccess', () => {
    it('should refuse a conversation the scope excludes', async () => {
      await expect(
        service.mayAccess(scope({ channelIds: [] }), 't1', 'c1'),
      ).resolves.toBe(false);
    });

    it('should refuse when there is no scope or no tenant', async () => {
      await expect(service.mayAccess(undefined, 't1', 'c1')).resolves.toBe(
        false,
      );
      await expect(service.mayAccess(scope(), undefined, 'c1')).resolves.toBe(
        false,
      );
    });

    it('should allow a conversation inside the scope', async () => {
      await expect(
        service.mayAccess(scope({ channelIds: ['ch_fb'] }), 't1', 'c1'),
      ).resolves.toBe(true);
    });
  });
});

describe('redactPii', () => {
  it('should leave a payload without customer details untouched', () => {
    const payload = { conversationId: 'c1', content: 'hi' };
    expect(redactPii(payload)).toBe(payload);
  });

  it('should not add fields that were not there', () => {
    const payload = { customer: { name: 'Sara' } };
    expect(redactPii(payload)).toEqual({ customer: { name: 'Sara' } });
  });

  it('should pass through non-objects', () => {
    expect(redactPii(null)).toBeNull();
    expect(redactPii('text')).toBe('text');
  });
});
