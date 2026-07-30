import { ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

const logger = new Logger('CrmBotInternalSecret');

/**
 * Validates the `x-crm-internal-secret` header on crm-bot ↔ crm-api internal
 * endpoints (which are `@Unprotected()`, i.e. not behind the Keycloak guard).
 *
 * Fails CLOSED: a missing/blank `CRM_BOT_INTERNAL_SECRET` rejects every request
 * instead of disabling the check — these endpoints are publicly reachable, so a
 * misconfigured env must never open them up.
 *
 * Comparison is timing-safe.
 */
export const assertCrmBotInternalSecret = (
  configService: ConfigService,
  provided: string | undefined,
): void => {
  const expected = configService.get<string>('CRM_BOT_INTERNAL_SECRET', {
    infer: true,
  });

  if (!expected) {
    logger.error(
      'CRM_BOT_INTERNAL_SECRET is not configured — rejecting internal request',
    );
    throw new ForbiddenException('Internal endpoint is not configured');
  }

  if (!provided || !timingSafeEqualStr(provided, expected)) {
    throw new ForbiddenException('Invalid internal secret');
  }
};

const timingSafeEqualStr = (a: string, b: string): boolean => {
  const actual = Buffer.from(a);
  const expected = Buffer.from(b);
  // Length is compared first because timingSafeEqual throws on length mismatch.
  // Secret length is not sensitive here (it is a fixed-length shared secret).
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
