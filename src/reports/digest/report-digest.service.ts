import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { format, subDays, subWeeks } from 'date-fns';
import { MailerService } from '../../mailer/mailer.service';
import { OmniConversationSchemaClass } from '../../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';
import { ContactSchemaClass } from '../../contacts/infrastructure/persistence/document/entities/contact.schema';
import { AllConfigType } from '../../config/config.type';

/**
 * ReportDigestService
 *
 * Sends a weekly KPI digest email every Monday at 08:00 UTC.
 *
 * The digest includes:
 *  • New contacts created (this week vs last week)
 *  • Conversations handled
 *  • Resolved conversations
 *  • Average response time (from DB aggregate)
 *
 * Recipients are configured via the DIGEST_EMAIL_RECIPIENTS env var
 * (comma-separated list of email addresses).
 */
@Injectable()
export class ReportDigestService {
  private readonly logger = new Logger(ReportDigestService.name);

  constructor(
    @InjectModel(OmniConversationSchemaClass.name)
    private readonly convModel: Model<any>,
    @InjectModel(ContactSchemaClass.name)
    private readonly contactModel: Model<any>,
    private readonly mailer: MailerService,
    private readonly config: ConfigService<AllConfigType>,
  ) {}

  /** Every Monday at 08:00 UTC */
  @Cron('0 8 * * 1')
  async sendWeeklyDigest(): Promise<void> {
    const recipients = this.getRecipients();
    if (recipients.length === 0) {
      this.logger.warn(
        '[Digest] No DIGEST_EMAIL_RECIPIENTS configured — skipping weekly digest',
      );
      return;
    }

    this.logger.log(
      `[Digest] Generating weekly digest for ${recipients.length} recipient(s)`,
    );

    try {
      const kpi = await this.buildKpi();
      await this.sendDigestEmail(recipients, kpi);
      this.logger.log('[Digest] Weekly digest sent successfully');
    } catch (err) {
      this.logger.error(
        `[Digest] Failed to send weekly digest: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  // ── Public for manual trigger via admin endpoint ─────────────────────────

  async triggerManual(recipients: string[]): Promise<void> {
    const kpi = await this.buildKpi();
    await this.sendDigestEmail(recipients, kpi);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async buildKpi(): Promise<WeeklyKpi> {
    const now = new Date();
    const thisWeekStart = subDays(now, 7);
    const lastWeekStart = subWeeks(thisWeekStart, 1);

    // ── New contacts ────────────────────────────────────────────────────────
    const [newContactsThisWeek, newContactsLastWeek] = await Promise.all([
      this.contactModel.countDocuments({
        createdAt: { $gte: thisWeekStart, $lte: now },
        deletedAt: { $exists: false },
      }),
      this.contactModel.countDocuments({
        createdAt: { $gte: lastWeekStart, $lt: thisWeekStart },
        deletedAt: { $exists: false },
      }),
    ]);

    // ── Conversations ───────────────────────────────────────────────────────
    const [totalConversations, resolvedConversations] = await Promise.all([
      this.convModel.countDocuments({
        createdAt: { $gte: thisWeekStart, $lte: now },
      }),
      this.convModel.countDocuments({
        resolvedAt: { $gte: thisWeekStart, $lte: now },
      }),
    ]);

    // ── Avg first response time (ms) ────────────────────────────────────────
    const frtAgg = await this.convModel.aggregate([
      {
        $match: {
          createdAt: { $gte: thisWeekStart, $lte: now },
          firstRespondedAt: { $exists: true },
        },
      },
      {
        $project: {
          frtMs: {
            $subtract: ['$firstRespondedAt', '$createdAt'],
          },
        },
      },
      { $group: { _id: null, avgFrtMs: { $avg: '$frtMs' } } },
    ]);

    const avgFrtMs: number = frtAgg[0]?.avgFrtMs ?? 0;
    const avgFrtFormatted = this.formatMs(avgFrtMs);

    return {
      period: `${format(thisWeekStart, 'dd MMM')} – ${format(now, 'dd MMM yyyy')}`,
      newContactsThisWeek,
      newContactsLastWeek,
      contactsDelta: newContactsThisWeek - newContactsLastWeek,
      totalConversations,
      resolvedConversations,
      resolutionRate:
        totalConversations > 0
          ? Math.round((resolvedConversations / totalConversations) * 100)
          : 0,
      avgFrtFormatted,
    };
  }

  private async sendDigestEmail(
    recipients: string[],
    kpi: WeeklyKpi,
  ): Promise<void> {
    const appName =
      (this.config.get('app.name' as any, { infer: true }) as
        | string
        | undefined) ?? 'CRM';

    const html = this.buildHtml(kpi, appName);

    await this.mailer.sendMail({
      to: recipients.join(', '),
      subject: `📊 ${appName} Weekly Digest — ${kpi.period}`,
      templatePath: '',
      context: {},
      html,
    });
  }

  private buildHtml(kpi: WeeklyKpi, appName: string): string {
    const deltaSign = kpi.contactsDelta >= 0 ? '+' : '';
    const deltaColor = kpi.contactsDelta >= 0 ? '#10b981' : '#ef4444';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${appName} Weekly Digest</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; margin: 0; padding: 24px; color: #1e293b; }
    .card { background: white; border-radius: 12px; padding: 24px; margin: 16px 0; border: 1px solid #e2e8f0; }
    .header { background: linear-gradient(135deg, #6366f1, #8b5cf6); border-radius: 16px; padding: 32px; color: white; text-align: center; margin-bottom: 24px; }
    .header h1 { margin: 0; font-size: 24px; }
    .header p { margin: 8px 0 0; opacity: 0.85; font-size: 14px; }
    .kpi-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
    .kpi { background: #f8fafc; border-radius: 10px; padding: 20px; text-align: center; border: 1px solid #e2e8f0; }
    .kpi-value { font-size: 32px; font-weight: 800; color: #1e293b; margin: 0; }
    .kpi-label { font-size: 12px; color: #64748b; margin: 4px 0 0; text-transform: uppercase; letter-spacing: 0.05em; }
    .delta { font-size: 13px; font-weight: 600; color: ${deltaColor}; margin-top: 4px; }
    .footer { text-align: center; font-size: 11px; color: #94a3b8; margin-top: 24px; }
    .section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div style="max-width: 600px; margin: 0 auto;">
    <div class="header">
      <h1>📊 ${appName} Weekly Digest</h1>
      <p>${kpi.period}</p>
    </div>

    <div class="card">
      <p class="section-title">📬 Conversations</p>
      <div class="kpi-grid">
        <div class="kpi">
          <p class="kpi-value">${kpi.totalConversations}</p>
          <p class="kpi-label">Total this week</p>
        </div>
        <div class="kpi">
          <p class="kpi-value">${kpi.resolvedConversations}</p>
          <p class="kpi-label">Resolved (${kpi.resolutionRate}%)</p>
        </div>
        <div class="kpi">
          <p class="kpi-value">${kpi.avgFrtFormatted}</p>
          <p class="kpi-label">Avg First Response</p>
        </div>
      </div>
    </div>

    <div class="card">
      <p class="section-title">👥 Contacts</p>
      <div class="kpi-grid">
        <div class="kpi">
          <p class="kpi-value">${kpi.newContactsThisWeek}</p>
          <p class="kpi-label">New this week</p>
          <p class="delta">${deltaSign}${kpi.contactsDelta} vs last week</p>
        </div>
        <div class="kpi">
          <p class="kpi-value">${kpi.newContactsLastWeek}</p>
          <p class="kpi-label">New last week</p>
        </div>
      </div>
    </div>

    <div class="footer">
      This digest is generated automatically every Monday. Reply to unsubscribe.
    </div>
  </div>
</body>
</html>`;
  }

  private getRecipients(): string[] {
    const raw = process.env.DIGEST_EMAIL_RECIPIENTS ?? '';
    return raw
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
  }

  private formatMs(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
  }
}

interface WeeklyKpi {
  period: string;
  newContactsThisWeek: number;
  newContactsLastWeek: number;
  contactsDelta: number;
  totalConversations: number;
  resolvedConversations: number;
  resolutionRate: number;
  avgFrtFormatted: string;
}
