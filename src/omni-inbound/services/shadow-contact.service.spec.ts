import { ShadowContactService } from './shadow-contact.service';
import { OmniPayload, resolvePayloadPhone } from '../domain/omni-payload';

/**
 * The identity ladder, and specifically the rung that did not exist.
 *
 * On WhatsApp the sender id IS the customer's MSISDN — the only phone in the
 * webhook's `metadata` is the BUSINESS's number. So a resolver reading
 * `metadata.phone` found nothing, phone matching never fired on the channel that
 * needs it most, and the shadow contact it created carried no phone at all. An
 * omni identity is `channel:senderId`, which can never compare equal to the
 * E.164 phone identity everything else dedups on, so that contact stayed
 * permanently unfindable by number: a duplicate nothing could later merge.
 */
const payload = (overrides: Partial<OmniPayload> = {}): OmniPayload =>
  ({
    tenantId: 'tenant_1',
    channelId: 'ch_1',
    channelAccount: 'biz_1',
    channelType: 'whatsapp',
    senderId: '966501234567',
    senderType: 'customer',
    messageType: 'text',
    content: 'hello',
    metadata: { phoneNumberId: 'biz_1', displayPhoneNumber: '+966112223333' },
    externalMessageId: 'm1',
    externalConversationId: 'c1',
    timestamp: new Date(),
    providerTimestamp: new Date(),
    ...overrides,
  }) as OmniPayload;

describe('resolvePayloadPhone', () => {
  it('should read the sender id as the phone on a phone-identity channel', () => {
    // WhatsApp only. `sms` and `voice` were listed here too, and neither channel
    // exists — no adapter, no capability entry, no way to receive one.
    expect(resolvePayloadPhone(payload())).toBe('966501234567');
  });

  it('should prefer an explicitly supplied phone', () => {
    // A livechat visitor who typed their number is more specific than a channel
    // convention.
    expect(
      resolvePayloadPhone(
        payload({
          channelType: 'livechat',
          senderId: 'visitor_abc',
          metadata: { phone: '0501234567' },
        }),
      ),
    ).toBe('0501234567');
  });

  it('should NOT invent a phone on a channel whose sender id is an opaque id', () => {
    // A Facebook PSID is not a phone number; treating it as one would write
    // garbage into `phones[]` and poison every dedup comparison after it.
    expect(
      resolvePayloadPhone(
        payload({
          channelType: 'facebook',
          senderId: 'psid_123',
          metadata: {},
        }),
      ),
    ).toBeUndefined();
  });

  it('should not mistake the business number in metadata for the customer', () => {
    // `phoneNumberId` / `displayPhoneNumber` belong to the WhatsApp Business
    // account. Reading either would attach every conversation in the tenant to
    // one contact.
    expect(resolvePayloadPhone(payload())).not.toBe('+966112223333');
  });
});

describe('ShadowContactService — WhatsApp identity', () => {
  const build = (overrides: { duplicates?: any[] } = {}) => {
    const contactsService = {
      findBySenderId: jest.fn().mockResolvedValue(null),
      findByEmail: jest.fn().mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue(null),
      mergeIdentity: jest.fn().mockResolvedValue(undefined),
      addEmailIfMissing: jest.fn().mockResolvedValue(undefined),
      checkDuplicate: jest.fn().mockResolvedValue({
        isDuplicate: (overrides.duplicates ?? []).length > 0,
        duplicates: overrides.duplicates ?? [],
      }),
      create: jest.fn().mockResolvedValue({ id: 'new_contact' }),
    };

    const service = new ShadowContactService(
      contactsService as any,
      {
        findById: jest.fn().mockResolvedValue({ ownerId: 'system_user' }),
      } as any,
      {
        getSetting: jest.fn().mockResolvedValue({ defaultCountryCode: '966' }),
      } as any,
      { emit: jest.fn() } as any,
      { acquire: jest.fn((_key, _ttl, fn: any) => fn()) } as any,
      { findContactByIdentity: jest.fn().mockResolvedValue(null) } as any,
    );

    return { service, contactsService };
  };

  it('should store the sender number as a phone on the new contact', async () => {
    const { service, contactsService } = build();

    await service.createShadowContact(payload());

    expect(contactsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ phones: ['+966501234567'] }),
    );
  });

  it('should normalise it to E.164 with the tenant dialling code', async () => {
    // Stored as `+966…` so it compares equal to the same person imported from a
    // CSV, which is the whole point of having it.
    const { service, contactsService } = build();

    await service.createShadowContact(payload({ senderId: '0501234567' }));

    expect(contactsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ phones: ['+966501234567'] }),
    );
  });

  it('should attach to the existing contact that already owns the number', async () => {
    const { service, contactsService } = build({
      duplicates: [{ id: 'existing', phone: '+966501234567' }],
    });

    const id = await service.createShadowContact(payload());

    expect(id).toBe('existing');
    expect(contactsService.create).not.toHaveBeenCalled();
    expect(contactsService.mergeIdentity).toHaveBeenCalledWith('existing', {
      channelType: 'whatsapp',
      senderId: '966501234567',
    });
  });

  it('should still resolve by phone when auto-merge is switched off', async () => {
    // `autoMergeShadowContact` governs matching on metadata the provider
    // volunteered. A channel whose sender id IS the number is an identity, not
    // an inference — and skipping it sends a duplicate phone into `create`,
    // where the identity unique index rejects it and the message ends up with no
    // contact at all.
    const { service, contactsService } = build({
      duplicates: [{ id: 'existing', phone: '+966501234567' }],
    });
    (service as any).settingsService.getSetting = jest
      .fn()
      .mockImplementation((key: string) =>
        key === 'omni_identity_resolution'
          ? Promise.resolve({ autoMergeShadowContact: false })
          : Promise.resolve({ defaultCountryCode: '966' }),
      );

    expect(await service.createShadowContact(payload())).toBe('existing');
    expect(contactsService.create).not.toHaveBeenCalled();
  });

  it('should leave phones empty for an opaque-id channel', async () => {
    const { service, contactsService } = build();

    await service.createShadowContact(
      payload({ channelType: 'facebook', senderId: 'psid_9', metadata: {} }),
    );

    expect(contactsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ phones: [] }),
    );
  });
});
