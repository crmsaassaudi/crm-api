import { Injectable, Logger } from '@nestjs/common';
import {
  ConnectionAdapter,
  ConnectionVerifyResult,
} from './connection-adapter.interface';

/**
 * SendGrid Connection Adapter.
 *
 * Verifies API Key by calling GET /v3/user/profile.
 * This is a lightweight, read-only endpoint that confirms authentication.
 */
@Injectable()
export class SendGridAdapter implements ConnectionAdapter {
  readonly providerType = 'sendgrid';
  private readonly logger = new Logger(SendGridAdapter.name);

  async verifyConnection(
    credentials: Record<string, any>,
    _settings: Record<string, any>,
  ): Promise<ConnectionVerifyResult> {
    const apiKey = credentials.apiKey;

    if (!apiKey) {
      return { success: false, error: 'API Key is required' };
    }

    try {
      const response = await fetch('https://api.sendgrid.net/v3/user/profile', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        this.logger.log('[SendGrid] ✅ Connection verified successfully');
        return { success: true };
      }

      const body = await response.text().catch(() => '(unreadable)');
      this.logger.warn(
        `[SendGrid] ❌ Verification failed: HTTP ${response.status} — ${body.substring(0, 200)}`,
      );

      if (response.status === 401 || response.status === 403) {
        return {
          success: false,
          error: 'Invalid API Key. Please check your SendGrid API Key.',
        };
      }

      return {
        success: false,
        error: `SendGrid returned HTTP ${response.status}: ${body.substring(0, 100)}`,
      };
    } catch (error: any) {
      this.logger.error(
        `[SendGrid] Connection error: ${error.message}`,
        error.stack,
      );
      return {
        success: false,
        error: `Connection failed: ${error.message}`,
      };
    }
  }
}
