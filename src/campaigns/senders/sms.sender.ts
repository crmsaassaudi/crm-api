import { Injectable } from '@nestjs/common';
import { TransportPoolService } from '../../channels/transport-pool.service';
import { SmsChannelConfig } from '../domain/campaign-channel';
import { personalise } from '../domain/personalise';
import {
  CampaignAbortError,
  CampaignSendSession,
  CampaignSender,
  SendOutcome,
} from './campaign-sender';

const TWILIO_API = 'https://api.twilio.com/2010-04-01/Accounts';
const SEND_TIMEOUT_MS = 15_000;

/**
 * SMS broadcast over Twilio.
 *
 * One-way by design. An SMS campaign expects no reply, so unlike the
 * conversational channels there is nothing to thread — which is also why SMS is
 * usable for broadcast at all while Facebook Messenger is not.
 */
@Injectable()
export class CampaignSmsSender implements CampaignSender {
  readonly channel = 'sms' as const;

  constructor(private readonly transportPool: TransportPoolService) {}

  async open(
    tenantId: string,
    config: SmsChannelConfig,
  ): Promise<CampaignSendSession> {
    const transport = await this.transportPool.resolveWithTenantGuard(
      config.configId,
      tenantId,
    );

    if (!transport || transport.providerType !== 'twilio') {
      throw new CampaignAbortError(
        'The SMS sender for this campaign no longer exists, or is not a Twilio sender.',
      );
    }

    const { accountSid, authToken } = transport.credentials;
    const fromNumber = transport.publicSettings?.fromNumber;
    if (!accountSid || !authToken || !fromNumber) {
      throw new CampaignAbortError(
        'The SMS sender for this campaign is missing its account details or sending number.',
      );
    }

    const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
    const endpoint = `${TWILIO_API}/${accountSid}/Messages.json`;

    return {
      send: (destination, merge) =>
        this.deliver({
          endpoint,
          authorization,
          fromNumber,
          destination,
          body: personalise(config.message, merge),
        }),
    };
  }

  private async deliver(params: {
    endpoint: string;
    authorization: string;
    fromNumber: string;
    destination: string;
    body: string;
  }): Promise<SendOutcome> {
    const response = await fetch(params.endpoint, {
      method: 'POST',
      headers: {
        Authorization: params.authorization,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: params.destination,
        From: params.fromNumber,
        Body: params.body,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    const payload = (await response.json().catch(() => null)) as {
      sid?: string;
      message?: string;
      code?: number;
    } | null;

    if (!response.ok) {
      // 401/403 mean the account credentials are wrong, which is true for every
      // remaining recipient — so the campaign stops rather than failing 100k
      // times with the same message.
      if (response.status === 401 || response.status === 403) {
        throw new CampaignAbortError(
          'Twilio rejected the account credentials for this campaign.',
        );
      }
      throw new Error(payload?.message ?? `Twilio returned ${response.status}`);
    }

    return { providerMessageId: payload?.sid ?? null };
  }
}
