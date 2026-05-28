import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { DlqJobData } from './dlq.service';

/**
 * Subscriber for `dlq.recorded` events.
 *
 * Responsibilities:
 *   1. Maintain a sliding 5-minute counter per queue. When the counter
 *      breaches `DLQ_ALERT_THRESHOLD` (default 10 events / queue / 5 min)
 *      a webhook is fired to `DLQ_ALERT_WEBHOOK_URL` (Slack-compatible
 *      payload).
 *   2. Throttle outbound alerts so a flood of failures does not produce
 *      a flood of Slack messages — at most one alert per queue every
 *      `DLQ_ALERT_COOLDOWN_SEC` (default 5 min).
 *
 * No state is persisted: the counter lives in-process per pod. That is
 * intentional — alerting must keep working even when Redis is the thing
 * that just died.
 */
@Injectable()
export class DlqAlertListener {
  private readonly logger = new Logger(DlqAlertListener.name);
  private readonly windowMs = 5 * 60 * 1_000;
  private readonly threshold = Number(process.env.DLQ_ALERT_THRESHOLD) || 10;
  private readonly cooldownMs =
    (Number(process.env.DLQ_ALERT_COOLDOWN_SEC) || 300) * 1_000;

  /** queueName -> Date.now() timestamps within current window. */
  private readonly timeline = new Map<string, number[]>();
  /** queueName -> last time we sent a Slack message. */
  private readonly lastAlert = new Map<string, number>();

  @OnEvent('dlq.recorded', { async: true })
  async handle(event: DlqJobData): Promise<void> {
    const now = Date.now();
    const buf = this.timeline.get(event.sourceQueue) ?? [];
    buf.push(now);
    // Prune entries older than the window.
    while (buf.length && now - buf[0] > this.windowMs) buf.shift();
    this.timeline.set(event.sourceQueue, buf);

    if (buf.length < this.threshold) return;

    const lastAt = this.lastAlert.get(event.sourceQueue) ?? 0;
    if (now - lastAt < this.cooldownMs) return;
    this.lastAlert.set(event.sourceQueue, now);

    const webhookUrl = process.env.DLQ_ALERT_WEBHOOK_URL;
    if (!webhookUrl) {
      this.logger.warn(
        `[DLQ] Threshold (${this.threshold}) crossed for queue=${event.sourceQueue} but DLQ_ALERT_WEBHOOK_URL not set — alert dropped`,
      );
      return;
    }

    const payload = {
      text:
        `:rotating_light: DLQ flood on *${event.sourceQueue}* — ` +
        `${buf.length} dead jobs in the last ${this.windowMs / 60_000} min. ` +
        `Latest: \`${event.jobName}\` (${event.error}).`,
      attachments: [
        {
          color: '#cc0000',
          fields: [
            { title: 'Queue', value: event.sourceQueue, short: true },
            { title: 'Job', value: event.jobName, short: true },
            {
              title: 'Last error',
              value: (event.error ?? '').slice(0, 500) || '(none)',
              short: false,
            },
            {
              title: 'Attempts',
              value: String(event.attemptsMade ?? 0),
              short: true,
            },
            { title: 'Failed at', value: event.failedAt, short: true },
          ],
        },
      ],
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!res.ok) {
          this.logger.warn(
            `[DLQ] Alert webhook returned ${res.status} for queue=${event.sourceQueue}`,
          );
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err: any) {
      this.logger.warn(
        `[DLQ] Failed to deliver alert for queue=${event.sourceQueue}: ${err?.message ?? err}`,
      );
    }
  }
}
