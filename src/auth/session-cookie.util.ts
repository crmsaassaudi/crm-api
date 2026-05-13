import type { CookieOptions, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../config/config.type';

export const SID_COOKIE = 'sid';

const getRootDomain = (configService: ConfigService<AllConfigType>): string =>
  configService.get('app.rootDomain', { infer: true }) || 'crmsaudi.dev';

const getCookieBaseOptions = (
  configService: ConfigService<AllConfigType>,
): CookieOptions => {
  const isProd =
    configService.get('app.nodeEnv', { infer: true }) === 'production';

  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
  };
};

export const getSessionCookieOptions = (
  configService: ConfigService<AllConfigType>,
  hostname: string,
): CookieOptions => {
  const baseOptions = getCookieBaseOptions(configService);
  const rootDomain = getRootDomain(configService);
  const normalizedHost = hostname.toLowerCase();
  const isLocalhost =
    normalizedHost === 'localhost' || normalizedHost === '127.0.0.1';

  if (isLocalhost) {
    return baseOptions;
  }

  return {
    ...baseOptions,
    domain:
      normalizedHost === rootDomain || normalizedHost.endsWith(`.${rootDomain}`)
        ? `.${rootDomain}`
        : undefined,
  };
};

export const clearSessionCookieVariants = (
  res: Response,
  configService: ConfigService<AllConfigType>,
  hostname: string,
): void => {
  const baseOptions = getCookieBaseOptions(configService);

  res.clearCookie(SID_COOKIE, baseOptions);

  const domainOptions = getSessionCookieOptions(configService, hostname);
  if (domainOptions.domain) {
    res.clearCookie(SID_COOKIE, domainOptions);
  }
};
