import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { BotReplyRequest, BotReplyResponse } from './bot-processing.types';

@Injectable()
export class BotApiService {
  private readonly logger = new Logger(BotApiService.name);

  constructor(private readonly configService: ConfigService) {}

  async reply(payload: BotReplyRequest): Promise<BotReplyResponse> {
    const baseUrl = this.resolveBotBaseUrl();
    const endpoint = `${baseUrl}/api/bot/typebot/reply`;

    const response = await axios.post<BotReplyResponse>(endpoint, payload, {
      timeout: this.resolveTimeoutMs(),
      headers: {
        'content-type': 'application/json',
      },
    });

    this.logger.debug(
      `crm-bot replied for conversation ${payload.conversationId}, inbound ${payload.inboundMessageId}`,
    );

    return response.data;
  }

  private resolveBotBaseUrl(): string {
    const raw =
      this.configService.get<string>('CRM_BOT_URL', { infer: true }) ||
      this.configService.get<string>('BOT_SERVICE_URL', { infer: true }) ||
      'http://localhost:4203';
    return raw.replace(/\/+$/, '');
  }

  private resolveTimeoutMs(): number {
    const raw = this.configService.get<string>('CRM_BOT_TIMEOUT_MS', {
      infer: true,
    });
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
  }
}
