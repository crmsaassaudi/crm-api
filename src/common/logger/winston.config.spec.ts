import * as fs from 'fs';
import * as path from 'path';
import { winstonConfig } from './winston.config';

/**
 * `winston.config.ts` was written — masking, JSON output, tenant/user context — and
 * then never imported: `app.module.ts` carried an inlined copy that had none of it.
 * So credentials were shipped to Loki verbatim while `sentry.bootstrap.ts` reasoned
 * from the assumption that the logger already masked them.
 *
 * These tests assert the masking reaches the actual transport format, not merely that
 * `maskSecrets` works in isolation — that was true the whole time it was bypassed.
 */
const clsStub = {
  get: (key: string) =>
    ({ correlationId: 'corr-1', tenantId: 't-1', userId: 'u-1' })[key],
  getId: () => 'cls-id',
} as any;

/** Push an entry through the configured Console transport's format chain. */
function transform(info: any) {
  const config = winstonConfig(clsStub);
  const format = (config.transports as any[])[0].format;
  return format.transform({ level: 'info', ...info });
}

describe('winstonConfig', () => {
  const original = process.env.LOG_FORMAT;
  afterEach(() => {
    if (original === undefined) delete process.env.LOG_FORMAT;
    else process.env.LOG_FORMAT = original;
  });

  it('should mask credentials in meta fields', () => {
    // This one failed on first run and found a real bug: the format passed each meta
    // VALUE to maskSecrets, which only redacts by key while walking an object. So a
    // top-level `access_token` came through in full while the same key nested one
    // level deeper was correctly redacted.
    process.env.LOG_FORMAT = 'json';
    const out: any = transform({
      message: 'channel connected',
      access_token: 'super-secret-value',
      nested: { client_secret: 'another-secret' },
    });

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('another-secret');
  });

  it('should mask bearer tokens and JWTs quoted back inside a message', () => {
    process.env.LOG_FORMAT = 'json';
    const out: any = transform({
      message:
        'request failed: Bearer abcdef1234567890 and eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    });

    expect(out.message).not.toContain('abcdef1234567890');
    expect(out.message).toContain('[REDACTED]');
    expect(out.message).toContain('[REDACTED_JWT]');
  });

  it('should emit JSON with tenant and user context when LOG_FORMAT=json', () => {
    process.env.LOG_FORMAT = 'json';
    const out: any = transform({ message: 'hello' });

    // The inlined copy carried correlationId only — tenant/user/service were absent,
    // which is what made per-tenant log queries impossible.
    expect(out.correlationId).toBe('corr-1');
    expect(out.tenantId).toBe('t-1');
    expect(out.userId).toBe('u-1');
    expect(out.service).toBeDefined();
  });

  it('should honour LOG_FORMAT=pretty', () => {
    process.env.LOG_FORMAT = 'pretty';
    const out: any = transform({ message: 'hello', context: 'Test' });
    // The pretty branch renders through printf into MESSAGE, not JSON fields.
    expect(typeof out[Symbol.for('message')]).toBe('string');
  });
});

describe('app.module logger wiring', () => {
  // A behavioural test cannot catch a re-inlined config: a second, worse Winston
  // setup passes every test above while being the one actually installed. That is
  // exactly how the masking sat bypassed, so this guard is structural.
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'app.module.ts'),
    'utf8',
  );

  it('should build its Winston options from winstonConfig', () => {
    expect(source).toContain("from './common/logger/winston.config'");
    expect(source).toMatch(/winstonConfig\(clsService\)/);
  });

  it('should not construct its own transports or formats inline', () => {
    expect(source).not.toContain('winston.transports.Console');
    expect(source).not.toContain('winston.format');
    expect(source).not.toContain('nestWinstonUtilities');
  });
});
