import { WebhookHeaderCryptoService } from './webhook-header-crypto.service';
import { ICryptoService } from '../../channels/domain/crypto.service';

class FakeCryptoService implements ICryptoService {
  // eslint-disable-next-line @typescript-eslint/require-await
  async encrypt(plaintext: string): Promise<string> {
    return Buffer.from(plaintext, 'utf8').toString('base64');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async decrypt(encrypted: string): Promise<string> {
    return Buffer.from(encrypted, 'base64').toString('utf8');
  }
}

describe('WebhookHeaderCryptoService', () => {
  let service: WebhookHeaderCryptoService;

  beforeEach(() => {
    service = new WebhookHeaderCryptoService(new FakeCryptoService());
  });

  it('should encrypt webhook header values in both headers map and headersArray', async () => {
    const result = await service.encryptNodes([
      {
        id: 'action-1',
        type: 'action',
        position: { x: 0, y: 0 },
        config: {
          actionType: 'webhook',
          headers: {
            Authorization: 'Bearer secret-token',
          },
          headersArray: [
            { key: 'Authorization', value: 'Bearer secret-token' },
          ],
        },
      },
    ]);

    const encryptedConfig = result.nodes[0].config;
    expect(result.changed).toBe(true);
    expect(encryptedConfig.headers.Authorization).toMatch(/^enc:v1:/);
    expect(encryptedConfig.headersArray[0].value).toMatch(/^enc:v1:/);
    expect(encryptedConfig.headers.Authorization).not.toContain('secret-token');
  });

  it('should decrypt encrypted headers and keeps legacy plaintext headers executable', async () => {
    const encrypted = await service.encryptWebhookConfig({
      actionType: 'webhook',
      headers: {
        Authorization: 'Bearer secret-token',
        'X-Legacy': 'plain-value',
      },
    });

    const resolved = await service.resolveHeadersForExecution(encrypted.config);
    const legacyResolved = await service.resolveHeadersForExecution({
      actionType: 'webhook',
      headers: { Authorization: 'Bearer legacy-token' },
    });

    expect(resolved.Authorization).toBe('Bearer secret-token');
    expect(resolved['X-Legacy']).toBe('plain-value');
    expect(legacyResolved.Authorization).toBe('Bearer legacy-token');
  });

  it('should does not double encrypt values that already use the webhook header envelope', async () => {
    const once = await service.encryptWebhookConfig({
      actionType: 'webhook',
      headers: { Authorization: 'Bearer secret-token' },
    });
    const twice = await service.encryptWebhookConfig(once.config);

    expect(twice.changed).toBe(false);
    expect(twice.config.headers.Authorization).toBe(
      once.config.headers.Authorization,
    );
  });

  it('should redacts webhook headers for list responses without mutating the input', () => {
    const nodes = [
      {
        id: 'action-1',
        type: 'action' as const,
        position: { x: 0, y: 0 },
        config: {
          actionType: 'webhook',
          headers: { Authorization: 'Bearer secret-token' },
          headersArray: [
            { key: 'Authorization', value: 'Bearer secret-token' },
          ],
        },
      },
    ];

    const redacted = service.redactNodes(nodes as any);

    expect(redacted[0].config.headers.Authorization).toBe('[redacted]');
    expect(redacted[0].config.headersArray[0].value).toBe('[redacted]');
    expect(nodes[0].config.headers.Authorization).toBe('Bearer secret-token');
  });
});
