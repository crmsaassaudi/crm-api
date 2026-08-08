import { BadRequestException } from '@nestjs/common';

/**
 * The channels a campaign can broadcast on.
 *
 * Deliberately NOT the full omni channel list. A campaign is an *unsolicited*
 * outbound message, and only these three can legally carry one:
 *
 *   email     — no platform restriction beyond the recipient's consent.
 *   sms       — same; one-way is fine here, a broadcast expects no reply.
 *   whatsapp  — only as a pre-approved template. Meta's 24-hour customer
 *               service window forbids free-form text to someone who has not
 *               messaged you recently, and `sendTemplate` is the documented
 *               exception.
 *
 * Facebook and Instagram are absent on purpose: Messenger has the same 24-hour
 * window with NO broadcast exception, so a "Facebook campaign" could only ever
 * reach people who already wrote to you in the last day — which is a reply, not
 * a campaign. Offering it would produce a feature that fails for most of its
 * audience and risks the Page.
 */
export const CAMPAIGN_CHANNELS = ['email', 'sms', 'whatsapp'] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

/**
 * Email content. `configId` points at a `ChannelConfig` of providerType `smtp`,
 * resolved through `TransportPoolService` so credentials stay encrypted at rest
 * and the tenant guard is applied on every read.
 */
export interface EmailChannelConfig {
  type: 'email';
  configId: string;
  subject: string;
  htmlBody: string;
  /** Overrides the transport's default display name, when set. */
  fromName?: string;
}

/** SMS content. `configId` points at a `ChannelConfig` of providerType `twilio`. */
export interface SmsChannelConfig {
  type: 'sms';
  configId: string;
  message: string;
}

/**
 * WhatsApp template send. `channelId` points at a `Channel` of type `whatsapp`
 * (which carries the phone_number_id in `account` and the access token in
 * `credentials`).
 *
 * `bodyParams` is positional because that is how the provider's template API
 * works — `{{1}}`, `{{2}}` in the approved template body, filled in order. Each
 * entry may itself contain personalisation tokens.
 */
export interface WhatsAppChannelConfig {
  type: 'whatsapp';
  channelId: string;
  templateName: string;
  languageCode: string;
  bodyParams?: string[];
}

export type CampaignChannelConfig =
  | EmailChannelConfig
  | SmsChannelConfig
  | WhatsAppChannelConfig;

const MAX_SMS_LENGTH = 1600;

/**
 * Validate a stored channel config against the shape its type promises.
 *
 * Runs at save time AND again in the worker before the first send: the document
 * is `Mixed` in Mongo, so nothing at the database layer stops a hand-edited
 * campaign from reaching the sender with a missing subject line.
 */
export function assertChannelConfig(
  config: unknown,
): asserts config is CampaignChannelConfig {
  if (!config || typeof config !== 'object') {
    throw new BadRequestException('Channel configuration is required.');
  }

  const candidate = config as Record<string, unknown>;
  const type = candidate.type;

  switch (type) {
    case 'email':
      requireText(candidate, 'configId', 'an email sender configuration');
      requireText(candidate, 'subject', 'a subject line');
      requireText(candidate, 'htmlBody', 'a message body');
      return;

    case 'sms': {
      requireText(candidate, 'configId', 'an SMS sender configuration');
      requireText(candidate, 'message', 'a message');
      const message = String(candidate.message);
      if (message.length > MAX_SMS_LENGTH) {
        throw new BadRequestException(
          `An SMS message cannot exceed ${MAX_SMS_LENGTH} characters.`,
        );
      }
      return;
    }

    case 'whatsapp':
      requireText(candidate, 'channelId', 'a WhatsApp channel');
      requireText(candidate, 'templateName', 'an approved template name');
      requireText(candidate, 'languageCode', 'a template language');
      if (
        candidate.bodyParams !== undefined &&
        (!Array.isArray(candidate.bodyParams) ||
          candidate.bodyParams.some((param) => typeof param !== 'string'))
      ) {
        throw new BadRequestException(
          'WhatsApp template parameters must be a list of strings.',
        );
      }
      return;

    default:
      throw new BadRequestException(
        `Unsupported campaign channel "${String(type)}". Supported: ${CAMPAIGN_CHANNELS.join(', ')}.`,
      );
  }
}

function requireText(
  candidate: Record<string, unknown>,
  key: string,
  describedAs: string,
): void {
  const value = candidate[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`This campaign needs ${describedAs}.`);
  }
}

export type ConsentField = 'emailOptIn' | 'smsOptIn' | 'whatsappOptIn';

/**
 * What blocks a channel from reaching a contact.
 *
 * `consentField` is the three-state flag for this channel: `false` is a refusal
 * and is enforced here, unconditionally and with no way to override it from a
 * campaign. `null` — never asked — is not blocked, because a tenant that has
 * only just imported its contacts has asked nobody, and refusing to send to them
 * would make the feature useless rather than safe. The preview reports that
 * count separately so it is a decision somebody makes, not a silence.
 *
 * `restrictionField` is a blanket refusal of outbound contact, independent of
 * any channel's consent.
 *
 * This table used to be empty for email, on the reasoning that a `false` could
 * not be told apart from a blank. That was true of a two-state flag, and the
 * consequence was that somebody who had unsubscribed still received the next
 * campaign. The fix was the third state, not the missing enforcement.
 */
export const CHANNEL_DELIVERY: Readonly<
  Record<
    CampaignChannel,
    { consentField: ConsentField; restrictionField?: 'doNotCall' }
  >
> = {
  email: { consentField: 'emailOptIn' },
  sms: { consentField: 'smsOptIn', restrictionField: 'doNotCall' },
  whatsapp: {
    consentField: 'whatsappOptIn',
    restrictionField: 'doNotCall',
  },
};
