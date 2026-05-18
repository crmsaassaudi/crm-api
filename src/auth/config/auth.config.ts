import { registerAs } from '@nestjs/config';

import { IsString } from 'class-validator';
import validateConfig from '../../utils/validate-config';
import { AuthConfig } from './auth-config.type';
import ms from 'ms';

class EnvironmentVariablesValidator {
  @IsString()
  AUTH_JWT_SECRET: string;

  @IsString()
  AUTH_JWT_TOKEN_EXPIRES_IN: string;

  @IsString()
  AUTH_REFRESH_SECRET: string;

  @IsString()
  AUTH_REFRESH_TOKEN_EXPIRES_IN: string;

  @IsString()
  AUTH_FORGOT_SECRET: string;

  @IsString()
  AUTH_FORGOT_TOKEN_EXPIRES_IN: string;

  @IsString()
  AUTH_CONFIRM_EMAIL_SECRET: string;

  @IsString()
  AUTH_CONFIRM_EMAIL_TOKEN_EXPIRES_IN: string;
}

export default registerAs<AuthConfig>('auth', () => {
  validateConfig(process.env, EnvironmentVariablesValidator);

  assertProductionSecret('AUTH_JWT_SECRET', process.env.AUTH_JWT_SECRET);
  assertProductionSecret(
    'AUTH_REFRESH_SECRET',
    process.env.AUTH_REFRESH_SECRET,
  );
  assertProductionSecret('AUTH_FORGOT_SECRET', process.env.AUTH_FORGOT_SECRET);
  assertProductionSecret(
    'AUTH_CONFIRM_EMAIL_SECRET',
    process.env.AUTH_CONFIRM_EMAIL_SECRET,
  );

  return {
    secret: process.env.AUTH_JWT_SECRET,
    expires: process.env.AUTH_JWT_TOKEN_EXPIRES_IN as ms.StringValue,
    refreshSecret: process.env.AUTH_REFRESH_SECRET,
    refreshExpires: process.env.AUTH_REFRESH_TOKEN_EXPIRES_IN as ms.StringValue,
    forgotSecret: process.env.AUTH_FORGOT_SECRET,
    forgotExpires: process.env.AUTH_FORGOT_TOKEN_EXPIRES_IN as ms.StringValue,
    confirmEmailSecret: process.env.AUTH_CONFIRM_EMAIL_SECRET,
    confirmEmailExpires: process.env
      .AUTH_CONFIRM_EMAIL_TOKEN_EXPIRES_IN as ms.StringValue,
  };
});

function assertProductionSecret(name: string, value?: string): void {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  const weakDefaults = new Set([
    'secret',
    'secret_for_refresh',
    'secret_for_forgot',
    'secret_for_confirm_email',
    'change-me',
  ]);

  if (!value || value.length < 32 || weakDefaults.has(value)) {
    throw new Error(`${name} must be at least 32 characters in production.`);
  }
}
