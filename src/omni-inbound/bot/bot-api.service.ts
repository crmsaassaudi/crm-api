import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { BotReplyRequest, BotAcceptResponse } from './bot-processing.types';

@Injectable()
export class BotApiService {
  private readonly logger = new Logger(BotApiService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Fire-and-forget: send request to bot, expect immediate 200 {accepted: true}.
   * Bot will process async and POST results back to callbackUrl.
   */
  async dispatch(payload: BotReplyRequest): Promise<BotAcceptResponse> {
    const baseUrl = this.resolveBotBaseUrl();
    const endpoint = `${baseUrl}/api/bot/typebot/reply`;

    const response = await axios.post<BotAcceptResponse>(endpoint, payload, {
      timeout: 3000, // Only waiting for acceptance, not processing
      headers: {
        'content-type': 'application/json',
      },
    });

    this.logger.debug(
      `crm-bot accepted request for conversation ${payload.conversationId}, inbound ${payload.inboundMessageId}`,
    );

    return response.data;
  }

  /** Build the callback URL that bot will POST results to */
  resolveCallbackUrl(): string {
    const raw =
      this.configService.get<string>('CRM_API_PUBLIC_URL', { infer: true }) ||
      this.configService.get<string>('API_BASE_URL', { infer: true }) ||
      'http://localhost:3002';
    return `${raw.replace(/\/+$/, '')}/v1/bot-callback/reply`;
  }

  private resolveBotBaseUrl(): string {
    const raw =
      this.configService.get<string>('CRM_BOT_URL', { infer: true }) ||
      this.configService.get<string>('BOT_SERVICE_URL', { infer: true }) ||
      'http://localhost:4203';
    return raw.replace(/\/+$/, '');
  }
}
