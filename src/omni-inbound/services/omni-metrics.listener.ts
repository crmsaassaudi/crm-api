import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { MetricsService } from '../../observability/metrics.service';
import { OmniEvents, CrmEvents } from '../domain/omni-events';
import type {
  MessagePersistedEvent,
  MessageSentEvent,
} from '../domain/omni-events';

/**
 * T-042: OmniMetricsListener — instruments omni-channel domain events
 * into MetricsService so Prometheus `/metrics` exposes operational telemetry.
 *
 * All counters use Prometheus naming convention: lowercase, underscore-separated,
 * with `_total` suffix for counters.
 *
 * This listener is fire-and-forget — metric recording must never block
 * the main event pipeline. Errors are swallowed with a warning log.
 */
@Injectable()
export class OmniMetricsListener {
  private readonly logger = new Logger(OmniMetricsListener.name);

  constructor(private readonly metrics: MetricsService) {}

  // ── Inbound Messages ────────────────────────────────────────────────────

  @OnEvent(OmniEvents.MESSAGE_PERSISTED, { async: true })
  handleMessagePersisted(event: MessagePersistedEvent): void {
    try {
      this.metrics.incrementCounter('omni_messages_inbound_total', {
        channel: event.channelType ?? 'unknown',
      });
    } catch {
      // Non-critical
    }
  }

  // ── Outbound Messages ───────────────────────────────────────────────────

  @OnEvent(OmniEvents.MESSAGE_SENT, { async: true })
  handleMessageSent(event: MessageSentEvent): void {
    try {
      this.metrics.incrementCounter('omni_messages_outbound_total', {
        channel: event.channelType ?? 'unknown',
        type: event.messageType ?? 'text',
      });
    } catch {
      // Non-critical
    }
  }

  // ── Conversation Lifecycle ──────────────────────────────────────────────

  @OnEvent(OmniEvents.CONVERSATION_CREATED, { async: true })
  handleConversationCreated(event: { channelType?: string }): void {
    try {
      this.metrics.incrementCounter('omni_conversations_created_total', {
        channel: event.channelType ?? 'unknown',
      });
    } catch {
      // Non-critical
    }
  }

  @OnEvent(OmniEvents.CONVERSATION_STATUS_CHANGED, { async: true })
  handleStatusChanged(event: {
    newStatus?: string;
    status?: string;
    channelType?: string;
  }): void {
    try {
      const status = event.newStatus ?? event.status;
      if (status === 'resolved' || status === 'closed') {
        this.metrics.incrementCounter('omni_conversations_resolved_total', {
          channel: event.channelType ?? 'unknown',
          status: status,
        });
      }
    } catch {
      // Non-critical
    }
  }

  // ── Assignment ──────────────────────────────────────────────────────────

  @OnEvent(OmniEvents.CONVERSATION_ASSIGNED, { async: true })
  handleAssignment(event: { reason?: string }): void {
    try {
      this.metrics.incrementCounter('omni_conversations_assigned_total', {
        reason: event.reason ?? 'manual',
      });
    } catch {
      // Non-critical
    }
  }

  // ── DLQ ─────────────────────────────────────────────────────────────────

  @OnEvent(CrmEvents.DLQ_RECORDED, { async: true })
  handleDlqRecorded(event: { sourceQueue?: string }): void {
    try {
      this.metrics.incrementCounter('omni_dlq_events_total', {
        queue: event.sourceQueue ?? 'unknown',
      });
    } catch {
      // Non-critical
    }
  }

  // ── Media Cache ─────────────────────────────────────────────────────────

  @OnEvent(OmniEvents.MESSAGE_MEDIA_CACHED, { async: true })
  handleMediaCached(): void {
    try {
      this.metrics.incrementCounter('omni_media_cache_total', {
        result: 'success',
      });
    } catch {
      // Non-critical
    }
  }

  @OnEvent(OmniEvents.MESSAGE_MEDIA_CACHE_FAILED, { async: true })
  handleMediaCacheFailed(): void {
    try {
      this.metrics.incrementCounter('omni_media_cache_total', {
        result: 'failure',
      });
    } catch {
      // Non-critical
    }
  }
}
