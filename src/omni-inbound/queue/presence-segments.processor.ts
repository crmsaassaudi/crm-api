import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  BaseTenantConsumer,
  TenantJobData,
} from '../../queue/base-tenant.consumer';
import { AgentStateSegmentRepository } from '../repositories/agent-state-segment.repository';
import { dayKeyOf, SegmentAxis } from '../domain/presence-segments';
import { PRESENCE_SEGMENTS_QUEUE } from './presence-segments-queue.constants';

export interface PresenceSegmentJobData extends TenantJobData {
  agentId: string;
  trigger?: string;
  segments: Array<{
    axis: SegmentAxis;
    value: string;
    startAtMs: number;
    endAtMs: number;
    durationMs: number;
  }>;
}

/**
 * Persists closed agent state segments to MongoDB off the socket hot-path.
 * dayKey is computed from each segment's startAt (UTC); the rollover cron
 * guarantees segments never cross a day boundary (§3.2).
 */
@Processor(PRESENCE_SEGMENTS_QUEUE)
export class PresenceSegmentsProcessor extends BaseTenantConsumer<PresenceSegmentJobData> {
  protected readonly logger = new Logger(PresenceSegmentsProcessor.name);
  protected readonly cls: ClsService;

  constructor(
    private readonly repo: AgentStateSegmentRepository,
    cls: ClsService,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(job: Job<PresenceSegmentJobData>): Promise<void> {
    const { tenantId, agentId, trigger, segments } = job.data;
    if (!segments?.length) return;

    await this.repo.createMany(
      segments.map((s) => ({
        tenantId,
        agentId,
        axis: s.axis,
        value: s.value,
        startAt: new Date(s.startAtMs),
        endAt: new Date(s.endAtMs),
        durationMs: s.durationMs,
        dayKey: dayKeyOf(s.startAtMs),
        trigger,
      })),
    );

    this.logger.debug(
      `Persisted ${segments.length} state segment(s) for agent ${agentId}`,
    );
  }
}
