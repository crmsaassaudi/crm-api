import { OutboundMediaHandler } from './outbound-media.handler';
import {
  SsrfBlockedError,
  SsrfGuardService,
} from '../common/http/ssrf-guard.service';
import { AttachmentSecurityService } from '../channels/services/attachment-security.service';

/**
 * `mediaUrl` on a bot callback is attacker-reachable: a flow author picks it,
 * and anyone holding the shared internal secret can post one directly. Before
 * these tests the handler called bare `fetch` on it and then delivered the
 * response body to the customer — a full-read SSRF, not a blind one.
 *
 * What is pinned here is the pair of rules that closes it: the fetch goes
 * through the SSRF guard, and a REJECTED url is never echoed back into the
 * conversation as text.
 */
describe('OutboundMediaHandler — bot media fetch', () => {
  const conversation = {
    id: 'conv_1',
    channelId: 'chan_1',
    channelType: 'livechat',
    customer: { externalId: 'cust_1' },
    lastCustomerMessageAt: new Date(),
  };

  const build = (
    ssrf: Partial<SsrfGuardService>,
    overrides: { messageRepo?: any } = {},
  ) => {
    const messageRepo = overrides.messageRepo ?? {
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'msg_1' }),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };
    const conversationRepo = {
      findById: jest.fn().mockResolvedValue(conversation),
      updateLastMessage: jest.fn().mockResolvedValue(undefined),
    };
    const channelRepo = {
      findByIdWithCredentials: jest
        .fn()
        .mockResolvedValue({ id: 'chan_1', credentials: {}, account: 'acc' }),
      findByAccountWithCredentials: jest.fn().mockResolvedValue(null),
    };
    const adapter = {
      sendMedia: jest
        .fn()
        .mockResolvedValue({ success: true, externalMessageId: 'ext_1' }),
    };

    const handler = new OutboundMediaHandler(
      messageRepo as any,
      conversationRepo as any,
      channelRepo as any,
      { emit: jest.fn() } as any,
      new Map([['livechat', adapter]]) as any,
      { channels: {} } as any,
      {} as any,
      { isProcessableImage: () => false } as any,
      {} as any,
      {} as any,
      ssrf as SsrfGuardService,
      new AttachmentSecurityService(),
    );

    return { handler, messageRepo, adapter };
  };

  const okResponse = (body: Uint8Array, headers: Record<string, string> = {}) =>
    new Response(body as unknown as BodyInit, {
      status: 200,
      headers: { 'content-type': 'image/jpeg', ...headers },
    });

  it('should refuse a url the SSRF guard blocks, without echoing it to the customer', async () => {
    const safeFetch = jest
      .fn()
      .mockRejectedValue(
        new SsrfBlockedError('SSRF blocked: 169.254.169.254 is link-local'),
      );
    const { handler, messageRepo } = build({ safeFetch } as any);
    const fallback = jest.fn();

    const result = await handler.sendBotMedia(
      {
        tenantId: 't1',
        conversationId: 'conv_1',
        mediaUrl: 'http://169.254.169.254/latest/meta-data/iam/',
        mediaType: 'image',
      },
      fallback,
    );

    expect(result).toMatchObject({ ok: false, blocked: true });
    // The old code fell back to `sendBotTextFallback` on ANY download failure,
    // which would have delivered the metadata URL into the conversation.
    expect(fallback).not.toHaveBeenCalled();
    expect(messageRepo.create).not.toHaveBeenCalled();
  });

  it('should route the fetch through the guard rather than calling fetch directly', async () => {
    const safeFetch = jest
      .fn()
      .mockResolvedValue(okResponse(new Uint8Array([1, 2, 3])));
    const { handler } = build({ safeFetch } as any);

    await handler.sendBotMedia(
      {
        tenantId: 't1',
        conversationId: 'conv_1',
        mediaUrl: 'https://cdn.example.com/a.jpg',
        mediaType: 'image',
      },
      jest.fn(),
    );

    expect(safeFetch).toHaveBeenCalledWith(
      'https://cdn.example.com/a.jpg',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('should reject a body larger than the cap instead of buffering it', async () => {
    const oversized = new Uint8Array(26 * 1024 * 1024);
    const safeFetch = jest.fn().mockResolvedValue(okResponse(oversized));
    const { handler, messageRepo } = build({ safeFetch } as any);
    const fallback = jest.fn().mockResolvedValue({ ok: true });

    await handler.sendBotMedia(
      {
        tenantId: 't1',
        conversationId: 'conv_1',
        mediaUrl: 'https://cdn.example.com/huge.jpg',
        mediaType: 'image',
      },
      fallback,
    );

    // Oversize is an ordinary download failure, not a blocked url — the link
    // still reaches the customer, but the bytes never reach the heap.
    expect(fallback).toHaveBeenCalled();
    expect(messageRepo.create).not.toHaveBeenCalled();
  });

  it('should reject a declared content-length over the cap before reading', async () => {
    const safeFetch = jest.fn().mockResolvedValue(
      okResponse(new Uint8Array([1]), {
        'content-length': String(30 * 1024 * 1024),
      }),
    );
    const { handler, messageRepo } = build({ safeFetch } as any);

    await handler.sendBotMedia(
      {
        tenantId: 't1',
        conversationId: 'conv_1',
        mediaUrl: 'https://cdn.example.com/liar.jpg',
        mediaType: 'image',
      },
      jest.fn().mockResolvedValue({ ok: true }),
    );

    expect(messageRepo.create).not.toHaveBeenCalled();
  });

  it('should apply the attachment blocklist to bot media, as it does to agent uploads', async () => {
    const safeFetch = jest
      .fn()
      .mockResolvedValue(okResponse(new Uint8Array([1, 2, 3])));
    const { handler, messageRepo } = build({ safeFetch } as any);
    const fallback = jest.fn();

    const result = await handler.sendBotMedia(
      {
        tenantId: 't1',
        conversationId: 'conv_1',
        mediaUrl: 'https://cdn.example.com/payload.exe',
        mediaType: 'file',
      },
      fallback,
    );

    expect(result).toMatchObject({ ok: false, blocked: true });
    expect(fallback).not.toHaveBeenCalled();
    expect(messageRepo.create).not.toHaveBeenCalled();
  });

  it('should still deliver ordinary media', async () => {
    const safeFetch = jest
      .fn()
      .mockResolvedValue(okResponse(new Uint8Array([1, 2, 3])));
    const { handler, messageRepo, adapter } = build({ safeFetch } as any);

    const result = await handler.sendBotMedia(
      {
        tenantId: 't1',
        conversationId: 'conv_1',
        mediaUrl: 'https://cdn.example.com/photo.jpg',
        mediaType: 'image',
      },
      jest.fn(),
    );

    expect(result).toMatchObject({ ok: true, status: 'sent' });
    expect(messageRepo.create).toHaveBeenCalled();
    expect(adapter.sendMedia).toHaveBeenCalled();
  });
});
