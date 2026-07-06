import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  AUTOMATION_ACTION_QUEUE,
  AUTOMATION_ACTION_DLQ,
  AUTOMATION_BULK_QUEUE,
  AUTOMATION_EMAIL_QUEUE,
  AUTOMATION_SMS_QUEUE,
  AUTOMATION_INTERNAL_QUEUE,
  AUTOMATION_WEBHOOK_QUEUE,
  AUTOMATION_DELAYED_QUEUE,
} from './automation-queue.constants';

/**
 * Registers BullMQ queues for the automation engine.
 *
 * Phase 4 — Per-action-type queues with independent rate limiting:
 *   - Email queue:    env AUTOMATION_EMAIL_RATE_LIMIT (default 500/min)
 *   - SMS queue:      env AUTOMATION_SMS_RATE_LIMIT (default 60/min — Twilio 1/s)
 *   - Internal queue: No rate limit (DB operations, fast)
 *   - Webhook queue:  env AUTOMATION_WEBHOOK_RATE_LIMIT (default 200/min)
 *   - DLQ:            Manual retry only
 *   - Bulk:           Throttled high-volume events
 *   - Delayed:        Wait/Delay node hibernation
 */
@Module({
  imports: [
    // ── Per-type action queues (Phase 4) ──────────────────────────────

    // Email queue — rate-limited for SendGrid
    BullModule.registerQueueAsync({
      name: AUTOMATION_EMAIL_QUEUE,
      useFactory: () => ({
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 3000 },
          removeOnComplete: 200,
          removeOnFail: 1000,
        },
        limiter: {
          max: parseInt(process.env.AUTOMATION_EMAIL_RATE_LIMIT ?? '500', 10),
          duration: 60_000, // per minute
        },
      }),
    }),

    // SMS queue — rate-limited for Twilio (default: 60/min = 1/s)
    BullModule.registerQueueAsync({
      name: AUTOMATION_SMS_QUEUE,
      useFactory: () => ({
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 200,
          removeOnFail: 1000,
        },
        limiter: {
          max: parseInt(process.env.AUTOMATION_SMS_RATE_LIMIT ?? '60', 10),
          duration: 60_000,
        },
      }),
    }),

    // Internal queue — UpdateField + RouteToTeam (no rate limit, fast DB ops)
    BullModule.registerQueue({
      name: AUTOMATION_INTERNAL_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 200,
        removeOnFail: 1000,
      },
    }),

    // Webhook queue — rate-limited for external endpoints
    BullModule.registerQueueAsync({
      name: AUTOMATION_WEBHOOK_QUEUE,
      useFactory: () => ({
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 200,
          removeOnFail: 1000,
        },
        limiter: {
          max: parseInt(process.env.AUTOMATION_WEBHOOK_RATE_LIMIT ?? '200', 10),
          duration: 60_000,
        },
      }),
    }),

    // ── Legacy main queue (backward compat — some code may still dispatch here) ─
    BullModule.registerQueue({
      name: AUTOMATION_ACTION_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: 200,
        removeOnFail: 1000,
      },
    }),

    // ── Dead Letter Queue ─────────────────────────────────────────────
    BullModule.registerQueue({
      name: AUTOMATION_ACTION_DLQ,
      defaultJobOptions: {
        removeOnComplete: 500,
        removeOnFail: 2000,
      },
    }),

    // ── Bulk queue — rate-limited for high-volume events ──────────────
    BullModule.registerQueue({
      name: AUTOMATION_BULK_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 1000,
      },
    }),

    // ── Delayed resume queue — Wait/Delay node hibernation ───────────
    BullModule.registerQueue({
      name: AUTOMATION_DELAYED_QUEUE,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    }),
  ],
  exports: [BullModule],
})
export class AutomationQueueModule {}
