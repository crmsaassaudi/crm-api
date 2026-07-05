import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import {
  ConnectionAdapter,
  ConnectionVerifyResult,
} from './connection-adapter.interface';
import { OAuth2TokenManager } from '../services/oauth2-token-manager.service';

/**
 * SMTP Connection Adapter.
 *
 * Verifies credentials by opening a real SMTP connection via nodemailer.
 * Supports Gmail (App Password), Outlook, and any standard SMTP server.
 *
 * Expected credentials: { user, password }
 * Expected settings:    { host, port, fromEmail, fromName? }
 */
@Injectable()
export class SmtpAdapter implements ConnectionAdapter {
  readonly providerType = 'smtp';
  private readonly logger = new Logger(SmtpAdapter.name);

  constructor(private readonly oauth2TokenManager: OAuth2TokenManager) {}

  async verifyConnection(
    credentials: Record<string, any>,
    settings: Record<string, any>,
  ): Promise<ConnectionVerifyResult> {
    const authType =
      credentials.authType ?? settings.authType ?? 'app_password';
    const { user, password } = credentials;
    const { host, port } = settings;

    const validationError = this.validateInputs(
      authType,
      user,
      password,
      credentials,
      settings,
      host,
      port,
    );
    if (validationError) return validationError;

    const numPort = Number(port);
    let transporter: nodemailer.Transporter | null = null;

    try {
      const resolvedCredentials = settings.oauthConfig
        ? await this.oauth2TokenManager.buildOAuth2Credentials(
            settings.oauthConfig,
            credentials,
          )
        : credentials;

      const auth =
        authType === 'oauth2'
          ? {
              type: 'OAuth2' as const,
              user,
              accessToken: resolvedCredentials.accessToken,
            }
          : { user, pass: password };

      transporter = nodemailer.createTransport({
        host,
        port: numPort,
        secure: numPort === 465, // Port 465 uses implicit TLS; others use STARTTLS
        auth,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 10_000,
      });

      await transporter.verify();
      this.logger.log(
        `[SMTP] ✅ Connection verified: ${user}@${host}:${numPort}`,
      );
      return { success: true };
    } catch (error: any) {
      this.logger.warn(
        `[SMTP] ❌ Verification failed for ${user}@${host}:${numPort}: ${error.message}`,
      );
      return this.mapSmtpError(error, host, numPort);
    } finally {
      transporter?.close?.();
    }
  }

  /** Validate all required inputs before attempting a connection. */
  private validateInputs(
    authType: string,
    user: string,
    password: string,
    credentials: Record<string, any>,
    settings: Record<string, any>,
    host: string,
    port: string | number,
  ): ConnectionVerifyResult | null {
    if (!user) return { success: false, error: 'Username is required' };
    if (authType === 'app_password' && !password) {
      return { success: false, error: 'Username and Password are required' };
    }
    if (
      authType === 'oauth2' &&
      !credentials.accessToken &&
      !settings.oauthConfig
    ) {
      return { success: false, error: 'OAuth2 access token is required' };
    }
    if (!host || !port) {
      return { success: false, error: 'SMTP Host and Port are required' };
    }
    const numPort = Number(port);
    if (isNaN(numPort) || numPort < 1 || numPort > 65535) {
      return { success: false, error: 'Port must be a valid number (1–65535)' };
    }
    return null;
  }

  /** Map nodemailer SMTP errors to user-friendly result messages. */
  private mapSmtpError(
    error: any,
    host: string,
    numPort: number,
  ): ConnectionVerifyResult {
    if (error.code === 'EAUTH' || error.responseCode === 535) {
      return {
        success: false,
        error:
          'Authentication failed. Please check your username and password. ' +
          'For Gmail, use an App Password (myaccount.google.com/apppasswords).',
      };
    }
    if (error.code === 'ECONNREFUSED') {
      return {
        success: false,
        error: `Connection refused at ${host}:${numPort}. Please verify the host and port.`,
      };
    }
    if (
      error.code === 'ETIMEDOUT' ||
      error.code === 'ESOCKET' ||
      error.code === 'ECONNECTION'
    ) {
      return {
        success: false,
        error: `Connection timed out to ${host}:${numPort}. The server may be unreachable.`,
      };
    }
    return {
      success: false,
      error: `SMTP verification failed: ${error.message}`,
    };
  }
}
