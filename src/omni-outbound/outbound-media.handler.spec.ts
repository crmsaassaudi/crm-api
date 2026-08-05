import { OutboundMediaHandler, renameForMime } from './outbound-media.handler';
import { validateForPlatform } from '../files/config/platform-limits.config';
import { ChannelType } from '../omni-inbound/domain/omni-payload';

/**
 * These tests pin the cases that used to pass WRONGLY.
 *
 * `validateForPlatform` existed, fully written, and was called by nothing: the
 * handler had its own weaker copy classifying media as `isImage ? image : file`.
 * Everything below marked "regression" describes something that reached the
 * provider and failed there, after the message was already persisted as `sending`.
 */
describe('validateForPlatform', () => {
  const MB = 1024 * 1024;
  const ch = (name: string) => name as unknown as ChannelType;

  it('should reject a media type the platform refuses outright', () => {
    // regression: `null` means "Zalo sends no video at all". The old code fell
    // through to the FILE limit and then skipped validation entirely, so this
    // was accepted here and refused by Zalo.
    expect(validateForPlatform(ch('zalo'), 'video/mp4', 2 * MB)).toBe(
      'zalo does not support video messages',
    );
    expect(validateForPlatform(ch('zalo'), 'audio/mpeg', 100_000)).toBe(
      'zalo does not support audio messages',
    );
    expect(validateForPlatform(ch('instagram'), 'audio/mpeg', 100_000)).toBe(
      'instagram does not support audio messages',
    );
  });

  it('should checks video against the video limit, not the document limit', () => {
    // regression: WhatsApp allows 64 MB documents but only 16 MB video. The old
    // `isImage ? image : file` split measured this 40 MB video against 64 MB.
    expect(validateForPlatform(ch('whatsapp'), 'video/mp4', 40 * MB)).toMatch(
      /exceeds whatsapp video limit of 16MB/,
    );
    // ...while a 40 MB document on the same channel is genuinely fine, which is
    // why the media-type split has to be per-type rather than image-vs-rest.
    expect(
      validateForPlatform(ch('whatsapp'), 'application/pdf', 40 * MB),
    ).toBeNull();
  });

  it('should enforce the allowed mime list', () => {
    // regression: never checked. Zalo takes jpeg/png only.
    expect(validateForPlatform(ch('zalo'), 'image/gif', 100_000)).toBe(
      'zalo does not support MIME type image/gif for image',
    );
    expect(validateForPlatform(ch('zalo'), 'image/jpeg', 100_000)).toBeNull();
  });

  it('should enforce the size limit for a supported type', () => {
    expect(validateForPlatform(ch('zalo'), 'image/jpeg', 2 * MB)).toMatch(
      /exceeds zalo image limit of 1MB/,
    );
  });

  it('should pass channels that have no published limits', () => {
    // This is the guard that keeps five live channels working. PLATFORM_LIMITS
    // covers 6 of the 11 KNOWN_CHANNELS; returning an error for the rest would
    // reject every attachment on them.
    for (const name of ['telegram', 'tiktok', 'sms', 'voice', 'shopee']) {
      expect(validateForPlatform(ch(name), 'image/jpeg', 900 * MB)).toBeNull();
      expect(validateForPlatform(ch(name), 'video/mp4', 900 * MB)).toBeNull();
    }
  });
});

describe('renameForMime', () => {
  it('should rewrite the extension when re-encoding changed the format', () => {
    expect(renameForMime('photo.webp', 'image/jpeg')).toBe('photo.jpg');
    expect(renameForMime('scan.PNG', 'image/jpeg')).toBe('scan.jpg');
    expect(renameForMime('my.holiday.photo.webp', 'image/jpeg')).toBe(
      'my.holiday.photo.jpg',
    );
  });

  it('should leave names that are already correct', () => {
    expect(renameForMime('photo.jpg', 'image/jpeg')).toBe('photo.jpg');
    // .jpeg and .jfif are valid JPEG names; rewriting them is pointless churn.
    expect(renameForMime('photo.jpeg', 'image/jpeg')).toBe('photo.jpeg');
    expect(renameForMime('photo.jfif', 'image/jpeg')).toBe('photo.jfif');
  });

  it('should leave names it cannot safely rewrite', () => {
    expect(renameForMime('report.pdf', 'application/pdf')).toBe('report.pdf');
    expect(renameForMime('noextension', 'image/jpeg')).toBe('noextension');
    // A leading-dot name has no basename to keep.
    expect(renameForMime('.gitignore', 'image/jpeg')).toBe('.gitignore');
  });
});

describe('OutboundMediaHandler.sendAgentMedia', () => {
  const MB = 1024 * 1024;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function build(
    overrides: {
      compress?: any;
      adapterChannel?: string;
      fileSize?: number;
      fileMimeType?: string;
      fileName?: string;
    } = {},
  ) {
    const sendMedia = jest.fn().mockResolvedValue({
      success: true,
      externalMessageId: 'ext-1',
    });
    const messageRepo = {
      create: jest.fn().mockResolvedValue({ id: 'msg-1' }),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };
    const conversationRepo = {
      findById: jest.fn().mockResolvedValue({
        channelType: 'zalo',
        channelId: 'ch-1',
        customer: { externalId: 'cust-1' },
      }),
      updateLastMessage: jest.fn().mockResolvedValue(undefined),
    };
    const channelRepo = {
      findByIdWithCredentials: jest
        .fn()
        .mockResolvedValue({ credentials: {}, account: {} }),
    };
    const fileSize = overrides.fileSize ?? 3 * MB;
    const fileMimeType = overrides.fileMimeType ?? 'image/jpeg';
    const fileName = overrides.fileName ?? 'photo.jpg';
    const filesService = {
      findById: jest.fn().mockResolvedValue({
        id: 'file-1',
        path: 'tenant/file-1',
        mimeType: fileMimeType,
        fileName,
      }),
      checkAccess: jest.fn().mockReturnValue(true),
      getPresignedDownloadUrl: jest
        .fn()
        .mockResolvedValue('https://files.test/file-1'),
    };
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      arrayBuffer: jest.fn().mockResolvedValue(Buffer.alloc(fileSize).buffer),
    } as any);
    const imageProcessingService = {
      isProcessableImage: jest.fn().mockReturnValue(true),
      compressForPlatform:
        overrides.compress ??
        jest.fn().mockResolvedValue({
          buffer: Buffer.alloc(400 * 1024),
          mimeType: 'image/jpeg',
          width: 1024,
          height: 768,
          originalSize: 3 * MB,
        }),
    };
    const deliveryCommands = {
      enqueue: jest
        .fn()
        .mockResolvedValue({ commandId: 'cmd-1', deferred: false }),
    };
    const handler = new OutboundMediaHandler(
      messageRepo as any,
      conversationRepo as any,
      channelRepo as any,
      { emit: jest.fn() } as any,
      new Map([[overrides.adapterChannel ?? 'zalo', { sendMedia }]]) as any,
      {} as any, // reply window disabled
      filesService as any,
      imageProcessingService as any,
      { findByIdsGlobal: jest.fn().mockResolvedValue([]) } as any,
      deliveryCommands as any,
      // Agent uploads resolve from S3 by fileId, so neither the SSRF guard nor
      // the attachment gateway is on this path; the bot media path covers them.
      { safeFetch: jest.fn() } as any,
      { scanAttachment: jest.fn().mockReturnValue({ safe: true }) } as any,
    );
    return {
      handler,
      messageRepo,
      sendMedia,
      imageProcessingService,
      conversationRepo,
      deliveryCommands,
    };
  }

  const send = (handler: OutboundMediaHandler, media: any) =>
    handler.sendAgentMedia({
      tenantId: 't-1',
      conversationId: 'c-1',
      agentId: 'a-1',
      media,
    });

  it('should send a photo that compression brings under the platform cap', async () => {
    // THE headline regression. Validation ran BEFORE compression, so a 3 MB phone
    // photo was rejected against Zalo's 1 MB cap even though the very next step
    // compressed it to 400 KB. Zalo is a primary channel; ordinary photos could
    // not be sent to it at all.
    const { handler, messageRepo, sendMedia } = build();

    const result = await send(handler, {
      fileId: 'file-1',
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
      size: 3 * MB,
    });

    expect(result.ok).toBe(true);
    expect(messageRepo.create).toHaveBeenCalledTimes(1);
    expect(sendMedia).not.toHaveBeenCalled();
    expect(result.status).toBe('sending');
  });

  it('should describe the re-encoded bytes downstream, not the upload', async () => {
    // compressForPlatform always emits JPEG. The old code threw its returned
    // mimeType away, so a WebP upload was persisted, emitted and dispatched as
    // `image/webp` over JPEG bytes.
    const { handler, messageRepo } = build();

    await send(handler, {
      fileId: 'file-1',
      mimeType: 'image/webp',
      fileName: 'photo.webp',
      size: 2 * MB,
    });

    const persisted = messageRepo.create.mock.calls[0][0];
    expect(persisted.metadata.media.mimeType).toBe('image/jpeg');
    expect(persisted.metadata.media.fileName).toBe('photo.jpg');
    expect(persisted.messageType).toBe('image');
  });

  it('should reject oversized video before persisting anything', async () => {
    const { handler, messageRepo, sendMedia, imageProcessingService } = build({
      adapterChannel: 'whatsapp',
      fileSize: 20 * MB,
      fileMimeType: 'video/mp4',
      fileName: 'clip.mp4',
    });
    imageProcessingService.isProcessableImage.mockReturnValue(false);
    (imageProcessingService as any).compressForPlatform = jest.fn();

    await expect(
      send(handler, {
        fileId: 'file-1',
        mimeType: 'video/mp4',
        fileName: 'clip.mp4',
        size: 20 * MB,
      }),
    ).rejects.toThrow(/does not support video messages/);

    // Nothing may be written for a send that never leaves the building.
    expect(messageRepo.create).not.toHaveBeenCalled();
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it('should keep the ORIGINAL type when compression fails', async () => {
    // Falling back to the original bytes while reporting the compressed type
    // would be the same lie in the other direction.
    const { handler, messageRepo, sendMedia } = build({
      compress: jest.fn().mockRejectedValue(new Error('sharp exploded')),
      fileSize: 500 * 1024,
      fileMimeType: 'image/png',
      fileName: 'photo.png',
    });

    await send(handler, {
      fileId: 'file-1',
      mimeType: 'image/png',
      fileName: 'photo.png',
      size: 500 * 1024,
    });

    expect(sendMedia).not.toHaveBeenCalled();
    const persisted = messageRepo.create.mock.calls[0][0];
    expect(persisted.metadata.media.mimeType).toBe('image/png');
    expect(persisted.metadata.media.fileName).toBe('photo.png');
  });
});
