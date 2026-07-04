import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { RedisService } from '../../redis/redis.service';
import { AgentPresenceService } from './agent-presence.service';
import {
  AxisSnapshot,
  ClosedSegment,
  OpenSegmentMap,
  diffSegments,
  rolloverSegments,
} from '../domain/presence-segments';
import { PRESENCE_SEGMENTS_QUEUE } from '../queue/presence-segments-queue.constants';

const openSegKey = (tenantId: string, userId: string) =>
  `omni:agent:open_seg:${tenantId}:${userId}`;

/** Open segments outlive a day; expire a bit over 24h as a safety net. */
const OPEN_SEG_TTL_SECONDS = 26 * 60 * 60;

/**
 * Drives the agent_state_segments reporting timeline (§3). It owns the
 * per-agent "open segment" map in Redis and, on every canonical state change,
 * closes/opens segments and enqueues the closed ones for persistence — keeping
 * the socket path fast. Registers itself as the presence state-change callback.
 */
@Injectable()
export class PresenceSegmentService implements OnModuleInit {
  private readonly logger = new Logger(PresenceSegmentService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly presenceService: AgentPresenceService,
    @InjectQueue(PRESENCE_SEGMENTS_QUEUE) private readonly queue: Queue,
  ) {}

  onModuleInit(): void {
    this.presenceService.setStateChangeCallback(
      (tenantId, userId, _before, after, trigger, atMs) =>
        this.recordStateChange(tenantId, userId, after, trigger, atMs),
    );
    this.logger.log('Registered presence state-change callback for segments');
  }

  private async readOpen(
    tenantId: string,
    userId: string,
  ): Promise<OpenSegmentMap> {
    const raw = await this.redis.getClient().get(openSegKey(tenantId, userId));
    if (!raw) return {};
    try {
      return JSON.parse(raw) as OpenSegmentMap;
    } catch {
      return {};
    }
  }

  private async writeOpen(
    tenantId: string,
    userId: string,
    open: OpenSegmentMap,
  ): Promise<void> {
    const client = this.redis.getClient();
    const key = openSegKey(tenantId, userId);
    if (Object.keys(open).length === 0) {
      await client.del(key);
    } else {
      await client.setex(key, OPEN_SEG_TTL_SECONDS, JSON.stringify(open));
    }
  }

  private async enqueue(
    tenantId: string,
    userId: string,
    trigger: string | undefined,
    closed: ClosedSegment[],
    keyPrefix: string,
    atMs: number,
  ): Promise<void> {
    if (closed.length === 0) return;
    await this.queue.add(
      'persist',
      {
        tenantId,
        agentId: userId,
        trigger,
        segments: closed.map((c) => ({
          axis: c.axis,
          value: c.value,
          startAtMs: c.startAtMs,
          endAtMs: c.endAtMs,
          durationMs: c.durationMs,
        })),
      },
      {
        // Deterministic id dedups retries / accidental double-fire at the same instant.
        jobId: `${keyPrefix}-${tenantId}-${userId}-${atMs}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: 200,
        removeOnFail: 1000,
      },
    );
  }

  /**
   * Close/open segments for an agent given the new canonical axis snapshot.
   * Invoked by the AgentPresenceService state-change callback on every change.
   */
  async recordStateChange(
    tenantId: string,
    userId: string,
    after: AxisSnapshot,
    trigger: string | undefined,
    atMs: number,
  ): Promise<void> {
    try {
      const open = await this.readOpen(tenantId, userId);
      const { closed, next } = diffSegments(open, after, atMs);
      await this.writeOpen(tenantId, userId, next);
      await this.enqueue(tenantId, userId, trigger, closed, 'seg', atMs);
    } catch (err: any) {
      this.logger.error(
        `recordStateChange failed for agent ${userId}: ${err.message}`,
      );
    }
  }

  /**
   * Midnight rollover for one agent (§3.2): close open segments at the day
   * boundary and re-open them so the new day's totals are self-contained.
   */
  async rolloverAgent(
    tenantId: string,
    userId: string,
    boundaryMs: number,
  ): Promise<void> {
    const open = await this.readOpen(tenantId, userId);
    if (Object.keys(open).length === 0) return;
    const { closed, next } = rolloverSegments(open, boundaryMs);
    await this.writeOpen(tenantId, userId, next);
    await this.enqueue(
      tenantId,
      userId,
      'system_day_rollover',
      closed,
      'roll',
      boundaryMs,
    );
  }
}
