import { MergeToken } from '../domain/personalise';
import {
  CampaignChannel,
  CampaignChannelConfig,
} from '../domain/campaign-channel';

export type MergeValues = Record<MergeToken, string>;

export interface SendOutcome {
  /** Provider-side id, when the provider returns one. */
  providerMessageId?: string | null;
}

/**
 * An open connection to a provider, reused across one batch of recipients.
 *
 * The session exists purely for throughput: opening an SMTP connection or
 * re-reading and decrypting channel credentials per recipient turns a 100-message
 * batch into 100 handshakes. Resolving them once per batch is the difference
 * between a campaign that takes minutes and one that takes hours.
 */
export interface CampaignSendSession {
  send(destination: string, merge: MergeValues): Promise<SendOutcome>;
  close?(): Promise<void>;
}

export interface CampaignSender {
  readonly channel: CampaignChannel;

  /**
   * Resolve credentials and validate the configuration.
   *
   * Throws `CampaignAbortError` if the campaign cannot possibly send — a deleted
   * sender config, a disconnected channel, wrong provider type. Failing here
   * means the run stops before the first message rather than recording the same
   * error against every recipient in the audience.
   */
  open(
    tenantId: string,
    config: CampaignChannelConfig,
  ): Promise<CampaignSendSession>;
}

/**
 * Raised when continuing would fail for every remaining recipient.
 *
 * Bad credentials, a revoked token, an exhausted daily quota — conditions that
 * belong to the campaign, not to the person being messaged. The send worker
 * pauses the campaign and surfaces the message, instead of burning through the
 * audience recording an identical failure a hundred thousand times.
 */
export class CampaignAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CampaignAbortError';
  }
}

/** DI token for the channel → sender map. */
export const CAMPAIGN_SENDERS = Symbol('CAMPAIGN_SENDERS');
export type CampaignSenderRegistry = Map<CampaignChannel, CampaignSender>;
