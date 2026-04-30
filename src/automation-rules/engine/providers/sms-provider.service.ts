import { Injectable, Logger } from '@nestjs/common';
import { ActionExecutionResult } from '../action-executors';

/**
 * SmsProviderService — abstract interface for sending SMS messages.
 *
 * Implementations:
 *   - TwilioSmsProvider: Production SMS via Twilio REST API
 *   - (Dry-run mode when no credentials configured)
 *
 * Provider is selected based on TWILIO_ACCOUNT_SID env var presence.
 */
export interface SmsProviderService {
  send(params: { to: string; message: string }): Promise<ActionExecutionResult>;
}

/**
 * Twilio SMS Provider.
 *
 * Uses Twilio REST API directly (fetch) to avoid heavy SDK dependency.
 * Falls to dry-run mode if no credentials configured.
 *
 * Environment Variables:
 *   TWILIO_ACCOUNT_SID - Twilio Account SID
 *   TWILIO_AUTH_TOKEN - Twilio Auth Token
 *   TWILIO_FROM_NUMBER - Sender phone number (E.164 format, e.g. +14155551234)
 */
@Injectable()
export class TwilioSmsProvider implements SmsProviderService {
  private readonly logger = new Logger(TwilioSmsProvider.name);
  private readonly accountSid: string | undefined;
  private readonly authToken: string | undefined;
  private readonly fromNumber: string | undefined;
  private readonly isDryRun: boolean;

  constructor() {
    this.accountSid = process.env.TWILIO_ACCOUNT_SID;
    this.authToken = process.env.TWILIO_AUTH_TOKEN;
    this.fromNumber = process.env.TWILIO_FROM_NUMBER;
    this.isDryRun = !this.accountSid || !this.authToken;

    if (this.isDryRun) {
      this.logger.warn(
        '[SmsProvider] No TWILIO credentials found — running in DRY-RUN mode (log only)',
      );
    } else {
      this.logger.log(
        `[SmsProvider] Twilio configured: from=${this.fromNumber}`,
      );
    }
  }

  async send(params: {
    to: string;
    message: string;
  }): Promise<ActionExecutionResult> {
    if (this.isDryRun) {
      this.logger.log(
        `[SmsProvider] DRY-RUN | to=${params.to} msgLength=${params.message.length}`,
      );
      return {
        success: true,
        output: {
          dryRun: true,
          to: params.to,
          messageLength: params.message.length,
        },
      };
    }

    try {
      // Twilio REST API — send SMS via fetch (no SDK dependency)
      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
      const authHeader = Buffer.from(
        `${this.accountSid}:${this.authToken}`,
      ).toString('base64');

      const body = new URLSearchParams({
        To: params.to,
        From: this.fromNumber || '',
        Body: params.message,
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        this.logger.error(
          `[SmsProvider] ❌ Twilio API error ${response.status}: ${errorBody}`,
        );
        return {
          success: false,
          error: {
            code: 'SMS_SEND_FAILED',
            message: `Twilio API ${response.status}: ${errorBody}`,
          },
        };
      }

      const result = await response.json();

      this.logger.log(
        `[SmsProvider] ✅ SMS sent to=${params.to} sid=${result.sid}`,
      );

      return {
        success: true,
        output: {
          sid: result.sid,
          to: params.to,
          status: result.status,
          messageLength: params.message.length,
        },
      };
    } catch (error: any) {
      this.logger.error(
        `[SmsProvider] ❌ Failed to send SMS: ${error.message}`,
        error.stack,
      );
      return {
        success: false,
        error: {
          code: 'SMS_SEND_FAILED',
          message: error.message,
        },
      };
    }
  }
}

/**
 * Factory token for SmsProviderService injection.
 */
export const SMS_PROVIDER_TOKEN = 'SMS_PROVIDER';
