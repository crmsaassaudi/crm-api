import { Injectable, Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { ActionExecutionResult } from '../action-executors';

/**
 * EmailProviderService — abstract interface for sending emails.
 *
 * Implementations:
 *   - SendGridEmailProvider: Production email via SendGrid SMTP relay
 *   - MockEmailProvider: Dev/test mode — logs email, always succeeds
 *
 * Provider is selected via factory based on SENDGRID_API_KEY env var.
 */
export interface EmailProviderService {
  send(params: {
    to: string;
    subject: string;
    body: string;
    from?: string;
  }): Promise<ActionExecutionResult>;
}

/**
 * SendGrid SMTP Email Provider.
 *
 * Uses nodemailer with SendGrid SMTP relay (smtp.sendgrid.net).
 * Falls back to MockEmailProvider behavior if no API key is configured.
 *
 * Environment Variables:
 *   SENDGRID_API_KEY - SendGrid API key (used as SMTP password)
 *   SENDGRID_FROM_EMAIL - Default sender email (default: noreply@crm.local)
 *   SENDGRID_FROM_NAME - Default sender name (default: CRM Automation)
 */
@Injectable()
export class SendGridEmailProvider implements EmailProviderService {
  private readonly logger = new Logger(SendGridEmailProvider.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly fromEmail: string;
  private readonly fromName: string;
  private readonly isDryRun: boolean;

  constructor() {
    const apiKey = process.env.SENDGRID_API_KEY;
    this.fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@crm.local';
    this.fromName = process.env.SENDGRID_FROM_NAME || 'CRM Automation';
    this.isDryRun = !apiKey;

    if (this.isDryRun) {
      this.logger.warn(
        '[EmailProvider] No SENDGRID_API_KEY found — running in DRY-RUN mode (log only)',
      );
      // Create a dummy transporter for dry-run
      this.transporter = nodemailer.createTransport({
        host: 'localhost',
        port: 1025,
        ignoreTLS: true,
        // Dev troubleshooting: bypass certificate validation
        tls: { rejectUnauthorized: false },
      });
    } else {
      // SendGrid SMTP relay configuration
      this.transporter = nodemailer.createTransport({
        host: 'smtp.sendgrid.net',
        port: 587,
        secure: false,
        auth: {
          user: 'apikey', // SendGrid requires literal "apikey" as the user
          pass: apiKey,
        },
        // Dev/troubleshooting: bypass certificate validation for non-prod
        tls: { rejectUnauthorized: false },
      });
      this.logger.log('[EmailProvider] SendGrid SMTP configured successfully');
    }
  }

  async send(params: {
    to: string;
    subject: string;
    body: string;
    from?: string;
  }): Promise<ActionExecutionResult> {
    const from = params.from || `"${this.fromName}" <${this.fromEmail}>`;

    if (this.isDryRun) {
      this.logger.log(
        `[EmailProvider] DRY-RUN | to=${params.to} subject="${params.subject}" bodyLength=${params.body.length}`,
      );
      return {
        success: true,
        output: {
          dryRun: true,
          to: params.to,
          subject: params.subject,
          bodyLength: params.body.length,
        },
      };
    }

    try {
      const result = await this.transporter.sendMail({
        from,
        to: params.to,
        subject: params.subject,
        html: params.body,
      });

      this.logger.log(
        `[EmailProvider] ✅ Email sent to=${params.to} messageId=${result.messageId}`,
      );

      return {
        success: true,
        output: {
          messageId: result.messageId,
          to: params.to,
          subject: params.subject,
        },
      };
    } catch (error: any) {
      this.logger.error(
        `[EmailProvider] ❌ Failed to send email: ${error.message}`,
        error.stack,
      );
      return {
        success: false,
        error: {
          code: 'EMAIL_SEND_FAILED',
          message: error.message,
        },
      };
    }
  }
}

/**
 * Factory token for EmailProviderService injection.
 */
export const EMAIL_PROVIDER_TOKEN = 'EMAIL_PROVIDER';
