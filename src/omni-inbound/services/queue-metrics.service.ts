import { Injectable } from '@nestjs/common';
import { ConversationRepository } from '../repositories/conversation.repository';

/** One queue: the conversations a given team owes an answer on. */
export interface QueueSnapshot {
  /** null = unassigned to any group ("general" queue). */
  groupId: string | null;
  depth: number;
  /** Seconds the longest-waiting customer in this queue has been waiting. */
  longestWaitSeconds: number;
  /** Mean wait across everything currently queued, in seconds. */
  averageWaitSeconds: number;
  /** How many have already missed an SLA deadline while waiting. */
  breachedCount: number;
  byChannel: Array<{ channelType: string; depth: number }>;
}

export interface QueueMetrics {
  /** Everything unowned right now, across all queues. */
  totalDepth: number;
  longestWaitSeconds: number;
  breachedCount: number;
  queues: QueueSnapshot[];
  /** When this snapshot was taken — a live figure needs a timestamp. */
  observedAt: Date;
}

/**
 * QueueMetricsService — how many customers are waiting, and how long.
 *
 * The module had no answer to this. Nothing recorded when a conversation entered
 * or left a queue, so time-to-assign, queue depth, longest wait and abandonment
 * were all uncomputable, and the supervisor screen showed agent presence only —
 * who is online, not who is waiting. A contact centre is managed on the second
 * number.
 *
 * Reads `queuedAt`, written by the ownership-timing fragment every assignment path
 * shares, and served by the partial `conversation_queue_wait` index so the query
 * touches only rows that are actually queued rather than the whole collection.
 */
@Injectable()
export class QueueMetricsService {
  constructor(private readonly conversations: ConversationRepository) {}

  async getMetrics(tenantId: string): Promise<QueueMetrics> {
    const rows = await this.conversations.aggregateQueueDepth(tenantId);
    const observedAt = new Date();

    const queues: QueueSnapshot[] = rows.map((row) => ({
      groupId: row.groupId,
      depth: row.depth,
      longestWaitSeconds: toSeconds(observedAt, row.oldestQueuedAt),
      // The mean of the wait *starts* is not the mean wait; the elapsed time has
      // to be computed against now, per row, which the aggregation returns as a
      // total so this stays one pass.
      averageWaitSeconds:
        row.depth === 0 ? 0 : Math.round(row.totalWaitMs / row.depth / 1000),
      breachedCount: row.breachedCount,
      byChannel: row.byChannel,
    }));

    return {
      totalDepth: queues.reduce((sum, queue) => sum + queue.depth, 0),
      longestWaitSeconds: queues.reduce(
        (max, queue) => Math.max(max, queue.longestWaitSeconds),
        0,
      ),
      breachedCount: queues.reduce(
        (sum, queue) => sum + queue.breachedCount,
        0,
      ),
      queues: queues.sort(
        (a, b) => b.longestWaitSeconds - a.longestWaitSeconds,
      ),
      observedAt,
    };
  }
}

function toSeconds(now: Date, since: Date | null): number {
  if (!since) return 0;
  return Math.max(0, Math.round((now.getTime() - since.getTime()) / 1000));
}
