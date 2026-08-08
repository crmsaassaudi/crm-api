import { WhatsAppAdapter } from '../adapters/whatsapp.adapter';

describe('WhatsAppAdapter', () => {
  let adapter: WhatsAppAdapter;

  beforeEach(() => {
    adapter = new WhatsAppAdapter(
      { findByName: jest.fn() } as any,
      { updateApprovalStatus: jest.fn() } as any,
    );
  });

  describe('channelType', () => {
    it('should return "whatsapp"', () => {
      expect(adapter.channelType).toBe('whatsapp');
    });
  });

  describe('normalize', () => {
    it('should normalize a text message', () => {
      const raw = {
        messaging_product: 'whatsapp',
        metadata: {
          phone_number_id: 'phone_123',
          display_phone_number: '+1234567890',
        },
        contacts: [{ profile: { name: 'John' }, wa_id: 'wa_001' }],
        messages: [
          {
            from: 'wa_001',
            id: 'wamid.abc123',
            timestamp: '1700000000',
            type: 'text',
            text: { body: 'Hello from WhatsApp!' },
          },
        ],
      };

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1')!;

      expect(result[0].channelType).toBe('whatsapp');
      expect(result[0].senderId).toBe('wa_001');
      expect(result[0].messageType).toBe('text');
      expect(result[0].content).toBe('Hello from WhatsApp!');
      expect(result[0].externalMessageId).toBe('wamid.abc123');
      expect(result[0].externalConversationId).toBe('wa_001_phone_123');
      expect(result[0].timestamp).toEqual(new Date(1700000000000));
      expect(result[0].metadata.contactName).toBe('John');
    });

    it('should normalize an image message with media ID', () => {
      const raw = {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: 'phone_123' },
        contacts: [{ profile: { name: 'Jane' }, wa_id: 'wa_002' }],
        messages: [
          {
            from: 'wa_002',
            id: 'wamid.img001',
            timestamp: '1700000000',
            type: 'image',
            image: {
              id: 'media_img_001',
              mime_type: 'image/jpeg',
              sha256: 'abc123',
              caption: 'Check this out!',
            },
          },
        ],
      };

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1')!;

      expect(result[0].messageType).toBe('image');
      expect(result[0].content).toBe('Check this out!');
      expect(result[0].mediaUrl).toBe('media_img_001');
      expect(result[0].metadata.mediaId).toBe('media_img_001');
      expect(result[0].metadata.mimeType).toBe('image/jpeg');
    });

    it('should normalize a document message', () => {
      const raw = {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: 'phone_123' },
        contacts: [],
        messages: [
          {
            from: 'wa_003',
            id: 'wamid.doc001',
            timestamp: '1700000000',
            type: 'document',
            document: {
              id: 'media_doc_001',
              mime_type: 'application/pdf',
              sha256: 'def456',
              filename: 'invoice.pdf',
            },
          },
        ],
      };

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1')!;

      expect(result[0].messageType).toBe('file');
      expect(result[0].metadata.mediaId).toBe('media_doc_001');
    });

    it('should normalize a location message', () => {
      const raw = {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: 'phone_123' },
        contacts: [],
        messages: [
          {
            from: 'wa_004',
            id: 'wamid.loc001',
            timestamp: '1700000000',
            type: 'location',
            location: {
              latitude: 10.762622,
              longitude: 106.660172,
              name: 'Ho Chi Minh City',
              address: 'Vietnam',
            },
          },
        ],
      };

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1')!;

      expect(result[0].messageType).toBe('location');
      expect(result[0].content).toContain('Ho Chi Minh City');
      expect(result[0].content).toContain('10.762622');
      expect(result[0].mediaUrl).toBeUndefined();
    });

    it('should return null — NOT throw — when the payload has no messages', () => {
      // This test previously expected a throw. Returning null is the correct
      // design and the reason is the delivery contract, not style: Meta retries
      // any non-2xx webhook with backoff, so throwing on a payload we simply
      // have nothing to do with would turn every status receipt into a retry
      // storm against our own endpoint. `normalize` returns `OmniPayload | null`
      // and the caller treats null as "acknowledge and skip".
      const raw = {
        messaging_product: 'whatsapp',
        metadata: {},
        contacts: [],
        messages: [],
      };

      expect(adapter.normalize(raw, 'tenant_1', 'channel_1')).toEqual([]);
    });

    it('should return null for a delivery-status webhook', () => {
      // The common shape of the above: WhatsApp sends delivered/read/failed
      // receipts in `statuses` with no `messages` at all.
      const raw = {
        messaging_product: 'whatsapp',
        metadata: {},
        statuses: [{ id: 'wamid.1', status: 'delivered' }],
      };

      expect(adapter.normalize(raw, 'tenant_1', 'channel_1')).toEqual([]);
    });

    it('should return null when the payload omits messages entirely', () => {
      // Not the same as an empty array — an absent key must not throw on
      // property access either.
      expect(
        adapter.normalize(
          { messaging_product: 'whatsapp', metadata: {} },
          'tenant_1',
          'channel_1',
        ),
      ).toEqual([]);
    });
  });
});
