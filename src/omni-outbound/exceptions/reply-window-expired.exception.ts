import { ForbiddenException } from '@nestjs/common';

/**
 * Thrown when an agent attempts to send a free-form message outside the
 * platform's reply window (e.g. 24h after the customer's last message).
 *
 * The frontend should catch this and prompt the agent to use template
 * messages (Zalo ZNS, FB Message Tags, WA Templates) instead.
 */
export class ReplyWindowExpiredException extends ForbiddenException {
  constructor(
    public readonly channelType: string,
    public readonly windowHours: number,
    public readonly lastCustomerMessageAt: Date,
    public readonly expiredSince: Date,
  ) {
    super({
      statusCode: 403,
      error: 'REPLY_WINDOW_EXPIRED',
      message: `Reply window expired. The ${channelType} ${windowHours}h messaging window closed at ${expiredSince.toISOString()}. Use template messages to continue the conversation.`,
      channelType,
      windowHours,
      lastCustomerMessageAt: lastCustomerMessageAt.toISOString(),
      expiredSince: expiredSince.toISOString(),
      suggestTemplate: true,
    });
  }
}
