import { OutboundQueueService } from './outbound-queue.service';

/**
 * Mock Redis client that simulates the ioredis interface used by OutboundQueueService.
 * Tracks keys in-memory for test assertions.
 */
function createMockRedisClient() {
  const store = new Map<string, string>();

  /* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(
      async (key: string, value: string, _mode?: string, _px?: number) => {
        store.set(key, value);
        return 'OK';
      },
    ),
    incrby: jest.fn(async (key: string, increment: number) => {
      const current = parseInt(store.get(key) || '0', 10);
      const next = current + increment;
      store.set(key, String(next));
      return next;
    }),
    expire: jest.fn(async () => 1),
    exists: jest.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    /* eslint-enable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
    // Helpers for test setup
    _store: store,
    _setKey: (key: string, value: string) => store.set(key, value),
    _clear: () => store.clear(),
  };
}

describe('OutboundQueueService', () => {
  let service: OutboundQueueService;
  let mockRedisClient: ReturnType<typeof createMockRedisClient>;
  let mockRedisService: any;

  const TEST_TENANT = 'tenant-1';
  const TEST_CONFIG = 'config-001';
  const GMAIL_HOST = 'smtp.gmail.com';
  const OFFICE365_HOST = 'smtp.office365.com';
  const FREE_OUTLOOK_HOST = 'smtp-mail.outlook.com';
  const CUSTOM_HOST = 'mail.company.com';

  beforeEach(() => {
    mockRedisClient = createMockRedisClient();
    mockRedisService = {
      getClient: jest.fn(() => mockRedisClient),
    };
    service = new OutboundQueueService(mockRedisService);
  });

  afterEach(() => {
    mockRedisClient._clear();
  });

  // ────────────────────────────────────────────────────────────────────────
  // 1. Bulk Campaign Guard
  // ────────────────────────────────────────────────────────────────────────
  describe('checkSendAllowed() — Bulk Campaign Guard', () => {
    it('should BLOCK campaigns with > 500 recipients', async () => {
      const result = await service.checkSendAllowed(
        TEST_TENANT,
        TEST_CONFIG,
        GMAIL_HOST,
        501,
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('501 recipients');
      expect(result.reason).toContain('Marketing Email');
      expect(result.reason).toContain('SendGrid');
    });

    it('should BLOCK campaigns with exactly 501 recipients', async () => {
      const result = await service.checkSendAllowed(
        TEST_TENANT,
        TEST_CONFIG,
        GMAIL_HOST,
        501,
      );
      expect(result.allowed).toBe(false);
    });

    it('should ALLOW exactly 500 recipients', async () => {
      const result = await service.checkSendAllowed(
        TEST_TENANT,
        TEST_CONFIG,
        GMAIL_HOST,
        500,
      );
      expect(result.allowed).toBe(true);
    });

    it('should ALLOW single recipient emails', async () => {
      const result = await service.checkSendAllowed(
        TEST_TENANT,
        TEST_CONFIG,
        GMAIL_HOST,
        1,
      );
      expect(result.allowed).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 2. Daily Quota Enforcement
  // ────────────────────────────────────────────────────────────────────────
  describe('checkSendAllowed() — Daily Quota', () => {
    it('should BLOCK when daily quota would be exceeded', async () => {
      // Seed Redis with 1999 sent emails for Gmail (limit: 2000)
      const dateKey = new Date().toISOString().split('should T')[0];
      const dailyKey = `outbound:daily:${TEST_TENANT}:${TEST_CONFIG}:${dateKey}`;
      mockRedisClient._setKey(dailyKey, '1999');

      const result = await service.checkSendAllowed(
        TEST_TENANT,
        TEST_CONFIG,
        GMAIL_HOST,
        2,
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Daily sending limit reached');
      expect(result.dailySent).toBe(1999);
      expect(result.dailyLimit).toBe(2000);
    });

    it('should ALLOW when within daily quota', async () => {
      const dateKey = new Date().toISOString().split('should T')[0];
      const dailyKey = `outbound:daily:${TEST_TENANT}:${TEST_CONFIG}:${dateKey}`;
      mockRedisClient._setKey(dailyKey, '100');

      const result = await service.checkSendAllowed(
        TEST_TENANT,
        TEST_CONFIG,
        GMAIL_HOST,
        1,
      );

      expect(result.allowed).toBe(true);
      expect(result.dailySent).toBe(100);
      expect(result.dailyLimit).toBe(2000);
    });

    it('should ALLOW the last email at exactly the limit', async () => {
      const dateKey = new Date().toISOString().split('should T')[0];
      const dailyKey = `outbound:daily:${TEST_TENANT}:${TEST_CONFIG}:${dateKey}`;
      mockRedisClient._setKey(dailyKey, '1999');

      const result = await service.checkSendAllowed(
        TEST_TENANT,
        TEST_CONFIG,
        GMAIL_HOST,
        1,
      );

      expect(result.allowed).toBe(true);
    });

    it('should use correct limit for Office365 (10000)', async () => {
      const result = await service.checkSendAllowed(
        TEST_TENANT,
        TEST_CONFIG,
        OFFICE365_HOST,
        1,
      );
      expect(result.allowed).toBe(true);
      expect(result.dailyLimit).toBe(10000);
    });

    it('should use correct limit for free Outlook (300)', async () => {
      const result = await service.checkSendAllowed(
        TEST_TENANT,
        TEST_CONFIG,
        FREE_OUTLOOK_HOST,
        1,
      );
      expect(result.allowed).toBe(true);
      expect(result.dailyLimit).toBe(300);
    });

    it('should use default limit (2000) for unknown SMTP hosts', async () => {
      const result = await service.checkSendAllowed(
        TEST_TENANT,
        TEST_CONFIG,
        CUSTOM_HOST,
        1,
      );
      expect(result.allowed).toBe(true);
      expect(result.dailyLimit).toBe(2000);
    });

    it('should handle 0 sent count gracefully (first email of the day)', async () => {
      const result = await service.checkSendAllowed(
        TEST_TENANT,
        TEST_CONFIG,
        GMAIL_HOST,
        1,
      );
      expect(result.allowed).toBe(true);
      expect(result.dailySent).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 3. Per-Second Throttle
  // ────────────────────────────────────────────────────────────────────────
  describe('checkSendAllowed() — Per-Second Throttle', () => {
    it('should BLOCK when per-second throttle key exists', async () => {
      const throttleKey = `outbound:throttle:${TEST_TENANT}:${TEST_CONFIG}`;
      mockRedisClient._setKey(throttleKey, '1');

      const result = await service.checkSendAllowed(
        TEST_TENANT,
        TEST_CONFIG,
        GMAIL_HOST,
        1,
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Sending too fast');
      expect(result.retryAfterMs).toBe(1000);
    });

    it('should ALLOW when throttle key does not exist', async () => {
      const result = await service.checkSendAllowed(
        TEST_TENANT,
        TEST_CONFIG,
        GMAIL_HOST,
        1,
      );
      expect(result.allowed).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 4. Check Priority Order (Bulk → Quota → Throttle)
  // ────────────────────────────────────────────────────────────────────────
  describe('checkSendAllowed() — Priority Order', () => {
    it('should check bulk guard BEFORE daily quota', async () => {
      // Even with quota exceeded, bulk guard takes priority
      const dateKey = new Date().toISOString().split('should T')[0];
      const dailyKey = `outbound:daily:${TEST_TENANT}:${TEST_CONFIG}:${dateKey}`;
      mockRedisClient._setKey(dailyKey, '9999');

      const result = await service.checkSendAllowed(
        TEST_TENANT,
        TEST_CONFIG,
        GMAIL_HOST,
        600,
      );

      // Bulk guard fires first (600 > 500 threshold)
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('600 recipients');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 5. Post-Send Recording
  // ────────────────────────────────────────────────────────────────────────
  describe('recordSend()', () => {
    it('should increment daily counter by recipientCount', async () => {
      await service.recordSend(TEST_TENANT, TEST_CONFIG, 5);

      expect(mockRedisClient.incrby).toHaveBeenCalledWith(
        expect.stringContaining(`outbound:daily:${TEST_TENANT}:${TEST_CONFIG}`),
        5,
      );
    });

    it('should set TTL of 48 hours on daily counter', async () => {
      await service.recordSend(TEST_TENANT, TEST_CONFIG, 1);

      expect(mockRedisClient.expire).toHaveBeenCalledWith(
        expect.stringContaining(`outbound:daily:${TEST_TENANT}:${TEST_CONFIG}`),
        48 * 60 * 60,
      );
    });

    it('should set per-second throttle key with 1000ms TTL', async () => {
      await service.recordSend(TEST_TENANT, TEST_CONFIG, 1);

      expect(mockRedisClient.set).toHaveBeenCalledWith(
        `outbound:throttle:${TEST_TENANT}:${TEST_CONFIG}`,
        '1',
        'PX',
        1000,
      );
    });

    it('should default recipientCount to 1', async () => {
      await service.recordSend(TEST_TENANT, TEST_CONFIG);

      expect(mockRedisClient.incrby).toHaveBeenCalledWith(
        expect.stringContaining('outbound:daily:'),
        1,
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 6. Daily Stats
  // ────────────────────────────────────────────────────────────────────────
  describe('getDailyStats()', () => {
    it('should return correct sent, limit, and remaining', async () => {
      const dateKey = new Date().toISOString().split('should T')[0];
      const dailyKey = `outbound:daily:${TEST_TENANT}:${TEST_CONFIG}:${dateKey}`;
      mockRedisClient._setKey(dailyKey, '150');

      const stats = await service.getDailyStats(
        TEST_TENANT,
        TEST_CONFIG,
        GMAIL_HOST,
      );

      expect(stats.sent).toBe(150);
      expect(stats.limit).toBe(2000);
      expect(stats.remaining).toBe(1850);
    });

    it('should return 0 sent when no Redis key exists', async () => {
      const stats = await service.getDailyStats(
        TEST_TENANT,
        TEST_CONFIG,
        GMAIL_HOST,
      );

      expect(stats.sent).toBe(0);
      expect(stats.remaining).toBe(2000);
    });

    it('should cap remaining at 0 when over quota', async () => {
      const dateKey = new Date().toISOString().split('should T')[0];
      const dailyKey = `outbound:daily:${TEST_TENANT}:${TEST_CONFIG}:${dateKey}`;
      mockRedisClient._setKey(dailyKey, '2500');

      const stats = await service.getDailyStats(
        TEST_TENANT,
        TEST_CONFIG,
        GMAIL_HOST,
      );

      expect(stats.remaining).toBe(0);
    });

    it('should use correct limit per SMTP host', async () => {
      const office = await service.getDailyStats(
        TEST_TENANT,
        TEST_CONFIG,
        OFFICE365_HOST,
      );
      expect(office.limit).toBe(10000);

      const freeOutlook = await service.getDailyStats(
        TEST_TENANT,
        TEST_CONFIG,
        FREE_OUTLOOK_HOST,
      );
      expect(freeOutlook.limit).toBe(300);

      const custom = await service.getDailyStats(
        TEST_TENANT,
        TEST_CONFIG,
        CUSTOM_HOST,
      );
      expect(custom.limit).toBe(2000);
    });
  });
});
