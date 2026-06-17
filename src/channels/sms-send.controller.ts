import {
  Controller,
  Post,
  Body,
  Logger,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { ChannelConfigRepository } from '../infrastructure/persistence/document/repositories/channel-config.repository';
import { CRYPTO_SERVICE_TOKEN, ICryptoService } from '../domain/crypto.service';

class SendSmsDto {
  configId: string;
  to: string;
  message: string;
  contactId?: string;
}

/**
 * SmsSendController — Standalone SMS send endpoint.
 *
 * Resolves SMS provider credentials from channel config,
 * then sends via Twilio REST API (same as SendSmsExecutor
 * in automation rules engine).
 */
@ApiTags('SMS Send')
@ApiBearerAuth()
@Controller({ path: 'channels', version: '1' })
export class SmsSendController {
  private readonly logger = new Logger(SmsSendController.name);

  constructor(
    private readonly cls: ClsService,
    private readonly configRepo: ChannelConfigRepository,
    @Inject(CRYPTO_SERVICE_TOKEN)
    private readonly crypto: ICryptoService,
  ) {}

  @Post('sms/send')
  @ApiOperation({ summary: 'Send standalone SMS (no conversation required)' })
  async sendSms(@Body() dto: SendSmsDto) {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Missing tenant context');
    }
    if (!dto.configId || !dto.to || !dto.message) {
      throw new BadRequestException('configId, to, and message are required');
    }

    // 1. Resolve SMS config
    const config = await this.configRepo.findByIdWithCredentials(
      tenantId,
      dto.configId,
    );
    if (!config) {
      throw new BadRequestException('SMS channel config not found');
    }
    if (!config.encryptedCredentials) {
      throw new BadRequestException(
        'SMS channel has no configured credentials',
      );
    }

    // 2. Decrypt credentials
    const credentials = JSON.parse(
      await this.crypto.decrypt(config.encryptedCredentials),
    );

    const accountSid = credentials.accountSid || credentials.twilioAccountSid;
    const authToken = credentials.authToken || credentials.twilioAuthToken;
    const fromNumber =
      credentials.fromNumber ||
      credentials.twilioPhoneNumber ||
      config.publicSettings?.fromNumber;

    if (!accountSid || !authToken || !fromNumber) {
      throw new BadRequestException(
        'Incomplete SMS credentials (accountSid, authToken, fromNumber required)',
      );
    }

    // 3. Send via Twilio REST API (same as TwilioSmsProvider)
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const params = new URLSearchParams({
      From: fromNumber,
      To: dto.to,
      Body: dto.message,
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      const data = await response.json();

      if (!response.ok) {
        this.logger.error(
          `[SmsSend] ❌ Twilio error: ${data.message || JSON.stringify(data)}`,
        );
        throw new BadRequestException(
          `Twilio error: ${data.message || 'Unknown error'}`,
        );
      }

      this.logger.log(
        `[SmsSend] ✅ Sent to=${dto.to} sid=${data.sid} from=${fromNumber}`,
      );

      return {
        ok: true,
        sid: data.sid,
        status: data.status,
      };
    } catch (error: any) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(`[SmsSend] ❌ Failed: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to send SMS: ${error.message}`);
    }
  }
}
