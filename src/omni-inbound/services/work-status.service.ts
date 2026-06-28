import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RedisService } from '../../redis/redis.service';
import { AgentPresenceService } from './agent-presence.service';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { InteractionSegmentRepository } from '../repositories/interaction-segment.repository';
import {
  InteractionType,
  WorkRecord,
  computeWorkStatus,
  interactionKey,
  isAllClosed,
} from '../domain/work-status';
import { dayKeyOf } from '../domain/presence-segments';
import {
  ConversationAssignedEvent,
  ConversationStatusChangedEvent,
} from '../domain/omni-events';

const workKey = (tenantId: string, userId: string) =>
  `omni:agent:work:${tenantId}:${userId}`;
const WORK_TTL_SECONDS = 26 * 60 * 60;
const DEFAULT_WRAP_UP_SECONDS = 120;

/**
 * Derives the system-managed `workStatus` (§2.4) from the set of interactions an
 * agent has open, and records per-interaction `interaction_segments` (gap D).
 *
 * Open-interaction state lives in Redis (`omni:agent:work:{t}:{u}`). On every
 * open/close we recompute the single priority-max label and push it into
 * AgentPresenceService.setWorkStatus(), which records the work-axis segment.
 *
 * Wired sources (events that exist today):
 *   - chat: omni.conversation.assigned / .status_changed(resolved|closed)
 * `openInteraction`/`closeInteraction` are generic so ticket/email/call can be
 * wired when those signals are emitted.
 */
@Injectable()
export class WorkStatusService {
  private readonly logger = new Logger(WorkStatusService.name);

  /** Pending WRAP_UP→IDLE re-evaluation timers, keyed `tenantId:userId`. */
  private readonly wrapTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly redis: RedisService,
    private readonly presenceService: AgentPresenceService,
    private readonly settingsService: CrmSettingsService,
    private readonly conversationRepo: ConversationRepository,
    private readonly interactionRepo: InteractionSegmentRepository,
  ) {}

  // ─── Redis record helpers ───────────────────────────────────────────

  private async read(tenantId: string, userId: string): Promise<WorkRecord> {
    const raw = await this.redis.getClient().get(workKey(tenantId, userId));
    if (!raw) return { open: {} };
    try {
      const parsed = JSON.parse(raw) as WorkRecord;
      return { open: parsed.open ?? {}, wrapUpUntilMs: parsed.wrapUpUntilMs };
    } catch {
      return { open: {} };
    }
  }

  private async write(
    tenantId: string,
    userId: string,
    record: WorkRecord,
  ): Promise<void> {
    const client = this.redis.getClient();
    const key = workKey(tenantId, userId);
    if (isAllClosed(record) && record.wrapUpUntilMs === undefined) {
      await client.del(key);
    } else {
      await client.setex(key, WORK_TTL_SECONDS, JSON.stringify(record));
    }
  }

  // ─── Public API (generic, extensible) ───────────────────────────────

  async openInteraction(
    tenantId: string,
    userId: string,
    type: InteractionType,
    refId: string,
  ): Promise<void> {
    if (!tenantId || !userId || !refId) return;
    try {
      const record = await this.read(tenantId, userId);
      const key = interactionKey(type, refId);
      if (record.open[key] === undefined) {
        record.open[key] = Date.now();
      }
      // A new interaction cancels any pending wrap-up.
      record.wrapUpUntilMs = undefined;
      await this.write(tenantId, userId, record);
      this.clearWrapTimer(tenantId, userId);
      await this.recompute(tenantId, userId, record);
    } catch (err: any) {
      this.logger.error(`openInteraction failed for ${userId}: ${err.message}`);
    }
  }

  async closeInteraction(
    tenantId: string,
    userId: string,
    type: InteractionType,
    refId: string,
    opts: { wrapUp?: boolean } = {},
  ): Promise<void> {
    if (!tenantId || !userId || !refId) return;
    try {
      const record = await this.read(tenantId, userId);
      const key = interactionKey(type, refId);
      const startedAt = record.open[key];
      if (startedAt === undefined) return; // not open — nothing to close
      delete record.open[key];

      // Persist the per-interaction segment (overlap-allowed analytics, gap D).
      const endedAt = Date.now();
      await this.persistInteractionSegment(
        tenantId,
        userId,
        type,
        refId,
        startedAt,
        endedAt,
      );

      // If nothing remains open and this close warrants wrap-up, open the window.
      if (opts.wrapUp && isAllClosed(record)) {
        const windowMs = (await this.getWrapUpSeconds(tenantId)) * 1000;
        record.wrapUpUntilMs = endedAt + windowMs;
        await this.write(tenantId, userId, record);
        await this.recompute(tenantId, userId, record);
        this.scheduleWrapTimer(tenantId, userId, windowMs + 100);
      } else {
        await this.write(tenantId, userId, record);
        await this.recompute(tenantId, userId, record);
      }
    } catch (err: any) {
      this.logger.error(`closeInteraction failed for ${userId}: ${err.message}`);
    }
  }

  private async recompute(
    tenantId: string,
    userId: string,
    record: WorkRecord,
  ): Promise<void> {
    const ws = computeWorkStatus(record, Date.now());
    await this.presenceService.setWorkStatus(tenantId, userId, ws);
  }

  private async persistInteractionSegment(
    tenantId: string,
    userId: string,
    type: InteractionType,
    refId: string,
    startMs: number,
    endMs: number,
  ): Promise<void> {
    try {
      await this.interactionRepo.create({
        tenantId,
        agentId: userId,
        type,
        refId,
        startAt: new Date(startMs),
        endAt: new Date(endMs),
        durationMs: Math.max(0, endMs - startMs),
        dayKey: dayKeyOf(startMs),
      });
    } catch (err: any) {
      this.logger.error(
        `Failed to persist interaction segment (${type}:${refId}): ${err.message}`,
      );
    }
  }

  // ─── WRAP_UP timer ──────────────────────────────────────────────────

  private scheduleWrapTimer(
    tenantId: string,
    userId: string,
    delayMs: number,
  ): void {
    const timerKey = `${tenantId}:${userId}`;
    this.clearWrapTimer(tenantId, userId);
    const timer = setTimeout(async () => {
      this.wrapTimers.delete(timerKey);
      try {
        const record = await this.read(tenantId, userId);
        // Wrap window elapsed → clear it and recompute (→ IDLE if still empty).
        if (isAllClosed(record)) {
          record.wrapUpUntilMs = undefined;
          await this.write(tenantId, userId, record);
        }
        await this.recompute(tenantId, userId, record);
      } catch (err: any) {
        this.logger.error(`wrap-up timer failed for ${userId}: ${err.message}`);
      }
    }, delayMs);
    this.wrapTimers.set(timerKey, timer);
  }

  private clearWrapTimer(tenantId: string, userId: string): void {
    const timerKey = `${tenantId}:${userId}`;
    const existing = this.wrapTimers.get(timerKey);
    if (existing) {
      clearTimeout(existing);
      this.wrapTimers.delete(timerKey);
    }
  }

  private async getWrapUpSeconds(tenantId: string): Promise<number> {
    try {
      const config = await this.settingsService.getSetting(
        'omni_presence',
        tenantId,
      );
      const v = (config as any)?.wrapUpWindowSeconds;
      return typeof v === 'number' && v > 0 ? v : DEFAULT_WRAP_UP_SECONDS;
    } catch {
      return DEFAULT_WRAP_UP_SECONDS;
    }
  }

  // ─── Event wiring (chat) ────────────────────────────────────────────

  @OnEvent('omni.conversation.assigned')
  async handleAssigned(event: ConversationAssignedEvent): Promise<void> {
    if (!event?.tenantId || !event?.conversationId) return;
    // A reassignment closes the chat for the previous owner.
    if (event.previousAgentId && event.previousAgentId !== event.agentId) {
      await this.closeInteraction(
        event.tenantId,
        event.previousAgentId,
        'chat',
        event.conversationId,
        { wrapUp: true },
      );
    }
    if (event.agentId) {
      await this.openInteraction(
        event.tenantId,
        event.agentId,
        'chat',
        event.conversationId,
      );
    }
  }

  @OnEvent('omni.conversation.status_changed')
  async handleStatusChanged(
    event: ConversationStatusChangedEvent & { status?: string },
  ): Promise<void> {
    if (!event?.tenantId || !event?.conversationId) return;
    const newStatus = event.newStatus ?? event.status;
    if (newStatus !== 'resolved' && newStatus !== 'closed') return;

    // status_changed does not carry the owner — resolve it from the conversation.
    const conv: any = await this.conversationRepo.findById(event.conversationId);
    const agentId = conv?.assignedAgentId;
    if (!agentId) return;

    await this.closeInteraction(
      event.tenantId,
      String(agentId),
      'chat',
      event.conversationId,
      { wrapUp: true },
    );
  }
}
