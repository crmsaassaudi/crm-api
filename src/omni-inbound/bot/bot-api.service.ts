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
    const secret = this.configService.get<string>('CRM_BOT_INTERNAL_SECRET', {
      infer: true,
    });

    this.logger.log(
      `[BOT-API] Dispatching to crm-bot: endpoint=${endpoint}, ` +
        `conv=${payload.conversationId}, msg=${payload.inboundMessageId}, ` +
        `sessionId=${payload.sessionId}, channel=${payload.channel}`,
    );

    try {
      const response = await axios.post<BotAcceptResponse>(endpoint, payload, {
        timeout: 3000, // Only waiting for acceptance, not processing
        headers: {
          'content-type': 'application/json',
          ...(secret ? { 'x-crm-internal-secret': secret } : {}),
        },
      });

      this.logger.log(
        `[BOT-API] ✓ crm-bot response: status=${response.status}, ` +
          `data=${JSON.stringify(response.data)}, conv=${payload.conversationId}`,
      );

      return response.data;
    } catch (error: any) {
      const status = error?.response?.status;
      const data = error?.response?.data;
      this.logger.error(
        `[BOT-API] ✗ crm-bot dispatch FAILED: status=${status}, ` +
          `data=${JSON.stringify(data)}, message=${error?.message}, ` +
          `endpoint=${endpoint}, conv=${payload.conversationId}`,
      );
      throw error;
    }
  }

  /**
   * Build the callback URL that bot will POST results to.
   *
   * Prioritizes CRM_API_INTERNAL_URL because crm-bot validates the callback
   * origin against its own CRM_API_INTERNAL_URL env var (SSRF protection).
   * Using the public URL would cause an origin mismatch in Docker/K8s
   * where internal and public URLs differ.
   */
  resolveCallbackUrl(): string {
    const raw =
      this.configService.get<string>('CRM_API_INTERNAL_URL', { infer: true }) ||
      this.configService.get<string>('CRM_API_PUBLIC_URL', { infer: true }) ||
      this.configService.get<string>('API_BASE_URL', { infer: true }) ||
      'http://localhost:3000';
    const apiPrefix =
      this.configService.get<string>('API_PREFIX', { infer: true }) || 'api';
    return `${raw.replace(/\/+$/, '')}/${apiPrefix}/v1/bot-callback/reply`;
  }

  private resolveBotBaseUrl(): string {
    const raw =
      this.configService.get<string>('CRM_BOT_URL', { infer: true }) ||
      this.configService.get<string>('BOT_SERVICE_URL', { infer: true }) ||
      'http://localhost:4203';
    return raw.replace(/\/+$/, '');
  }
}
