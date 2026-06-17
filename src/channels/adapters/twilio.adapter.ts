import { Injectable, Logger } from '@nestjs/common';
import {
  ConnectionAdapter,
  ConnectionVerifyResult,
} from './connection-adapter.interface';

/**
 * Twilio Connection Adapter.
 *
 * Verifies Account SID + Auth Token by calling GET /2010-04-01/Accounts/{SID}.json
 * This is a lightweight, read-only endpoint that confirms authentication.
 */
@Injectable()
export class TwilioAdapter implements ConnectionAdapter {
  readonly providerType = 'twilio';
  private readonly logger = new Logger(TwilioAdapter.name);

  async verifyConnection(
    credentials: Record<string, any>,

    _settings: Record<string, any>,
  ): Promise<ConnectionVerifyResult> {
    const accountSid = credentials.accountSid;
    const authToken = credentials.authToken;

    if (!accountSid || !authToken) {
      return {
        success: false,
        error: 'Account SID and Auth Token are both required',
      };
    }

    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`;
      const authHeader = Buffer.from(`${accountSid}:${authToken}`).toString(
        'base64',
      );

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Basic ${authHeader}`,
        },
      });

      if (response.ok) {
        this.logger.log('[Twilio] ✅ Connection verified successfully');
        return { success: true };
      }

      const body = await response.text().catch(() => '(unreadable)');
      this.logger.warn(
        `[Twilio] ❌ Verification failed: HTTP ${response.status} — ${body.substring(0, 200)}`,
      );

      if (response.status === 401) {
        return {
          success: false,
          error:
            'Invalid credentials. Please check your Account SID and Auth Token.',
        };
      }

      return {
        success: false,
        error: `Twilio returned HTTP ${response.status}: ${body.substring(0, 100)}`,
      };
    } catch (error: any) {
      this.logger.error(
        `[Twilio] Connection error: ${error.message}`,
        error.stack,
      );
      return {
        success: false,
        error: `Connection failed: ${error.message}`,
      };
    }
  }
}
