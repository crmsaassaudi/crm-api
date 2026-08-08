import { Injectable } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { TransportPoolService } from '../../channels/transport-pool.service';
import { OutboundQueueService } from '../../channels/services/outbound-queue.service';
import { EmailChannelConfig } from '../domain/campaign-channel';
import { TemplateVariableRegistryService } from '../../templates/services/template-variable-registry.service';
import {
  CampaignAbortError,
  CampaignSendSession,
  CampaignSender,
  MergeValues,
  SendOutcome,
} from './campaign-sender';

/** Parallel SMTP connections per batch. Above this most relays start refusing. */
const SMTP_POOL_SIZE = 5;

@Injectable()
export class CampaignEmailSender implements CampaignSender {
  readonly channel = 'email' as const;

  constructor(
    private readonly transportPool: TransportPoolService,
    private readonly outboundQueue: OutboundQueueService,
    private readonly variableRegistry: TemplateVariableRegistryService,
  ) {}

  async open(
    tenantId: string,
    config: EmailChannelConfig,
  ): Promise<CampaignSendSession> {
    // Always the tenant-guarded resolve: the pool's plain `resolve` is
    // tenant-blind, and a campaign is exactly the place a leaked configId would
    // let one tenant send through another's mail server.
    const transport = await this.transportPool.resolveWithTenantGuard(
      config.configId,
      tenantId,
    );

    if (!transport || transport.providerType !== 'smtp') {
      throw new CampaignAbortError(
        'The email sender for this campaign no longer exists, or is not an SMTP sender.',
      );
    }

    const { user, password } = transport.credentials;
    const { host, port, fromEmail, fromName } = transport.publicSettings;
    const smtpPort = Number(port);
    if (!host || !smtpPort) {
      throw new CampaignAbortError(
        'The email sender for this campaign has no SMTP host configured.',
      );
    }

    const transporter = nodemailer.createTransport({
      host,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user, pass: password },
      pool: true,
      maxConnections: SMTP_POOL_SIZE,
      tls: { rejectUnauthorized: process.env.NODE_ENV === 'production' },
    });

    const from = this.buildFrom(config.fromName ?? fromName, fromEmail ?? user);

    return {
      send: (destination, merge) =>
        this.deliver({
          transporter,
          config,
          from,
          host,
          tenantId,
          destination,
          merge,
        }),
      close: () => {
        transporter.close();
        return Promise.resolve();
      },
    };
  }

  private async deliver(params: {
    transporter: Transporter;
    config: EmailChannelConfig;
    from: string;
    host: string;
    tenantId: string;
    destination: string;
    merge: MergeValues;
  }): Promise<SendOutcome> {
    const { tenantId, config, host, destination, merge } = params;

    // Counted one recipient at a time, which is what makes the provider's daily
    // cap meaningful here: `checkSendAllowed` hard-refuses any single call above
    // 500 recipients, so a campaign must never present its audience as one send.
    const throttle = await this.outboundQueue.checkSendAllowed(
      tenantId,
      config.configId,
      host,
      1,
    );
    if (!throttle.allowed) {
      // The mailbox's own limit, not this recipient's problem — every remaining
      // send would hit the same wall, so the campaign pauses and can be resumed
      // tomorrow with its ledger intact.
      throw new CampaignAbortError(
        throttle.reason ??
          'This mailbox has reached its daily sending limit. The campaign is paused and can be resumed once the limit resets.',
      );
    }

    const info = await params.transporter.sendMail({
      from: params.from,
      to: destination,
      subject: this.variableRegistry.render(config.subject, merge, {
        mode: 'strict',
        purpose: 'campaign',
      }),
      html: this.variableRegistry.render(config.htmlBody, merge, {
        mode: 'strict',
        purpose: 'campaign',
      }),
    });

    await this.outboundQueue.recordSend(tenantId, config.configId, 1);

    return {
      providerMessageId:
        typeof info?.messageId === 'string' ? info.messageId : null,
    };
  }

  private buildFrom(displayName: string | undefined, address: string): string {
    // A display name containing a quote or a newline would break out of the
    // header, so it is dropped rather than escaped — the address is what has to
    // be right.
    const safeName = (displayName ?? '').replace(/["\r\n]/g, '').trim();
    return safeName ? `"${safeName}" <${address}>` : address;
  }
}
