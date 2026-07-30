import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertCrmBotInternalSecret } from './internal-secret.util';

const configWith = (secret?: string) =>
  ({ get: () => secret }) as unknown as ConfigService;

describe('assertCrmBotInternalSecret', () => {
  it('should accept the configured secret', () => {
    expect(() =>
      assertCrmBotInternalSecret(configWith('s3cret-value'), 's3cret-value'),
    ).not.toThrow();
  });

  it('should reject a wrong secret', () => {
    expect(() =>
      assertCrmBotInternalSecret(configWith('s3cret-value'), 'wrong-value'),
    ).toThrow(ForbiddenException);
  });

  it('should reject a secret of a different length without throwing on the comparison', () => {
    expect(() =>
      assertCrmBotInternalSecret(configWith('s3cret-value'), 'short'),
    ).toThrow(ForbiddenException);
  });

  it('should reject a missing header', () => {
    expect(() =>
      assertCrmBotInternalSecret(configWith('s3cret-value'), undefined),
    ).toThrow(ForbiddenException);
  });

  it('should fail CLOSED when the secret is not configured', () => {
    // Regression guard: this used to log a warning and return, which left the
    // @Unprotected() internal endpoints open to the whole internet.
    expect(() =>
      assertCrmBotInternalSecret(configWith(undefined), 'anything'),
    ).toThrow(ForbiddenException);
    expect(() => assertCrmBotInternalSecret(configWith(''), '')).toThrow(
      ForbiddenException,
    );
  });
});
