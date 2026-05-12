import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisService } from '../../redis/redis.service';
import { ConversationRepository } from '../repositories/conversation.repository';

export interface ConversationLock {
  tenantId: string;
  conversationId: string;
  agentId: string;
  agentName?: string | null;
  lockedAt: string;
  expiresAt: string;
  source: string;
}

@Injectable()
export class ConversationLockService {
  private readonly logger = new Logger(ConversationLockService.name);
  private readonly ttlSeconds = 120;

  constructor(
    private readonly redisService: RedisService,
    private readonly conversationRepo: ConversationRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async getLock(
    tenantId: string,
    conversationId: string,
  ): Promise<ConversationLock | null> {
    const raw = await this.redisService
      .getClient()
      .get(this.key(tenantId, conversationId));
    return this.parseLock(raw);
  }

  async acquireLock(params: {
    tenantId: string;
    conversationId: string;
    agentId: string;
    agentName?: string | null;
    source?: string;
  }): Promise<{ acquired: boolean; lock: ConversationLock }> {
    await this.assertConversationExists(params.conversationId);

    const existing = await this.getLock(params.tenantId, params.conversationId);
    if (existing && existing.agentId !== params.agentId) {
      throw new ConflictException({
        message: 'Conversation is locked by another agent',
        lock: existing,
      });
    }

    const lock = this.buildLock(params);
    const key = this.key(params.tenantId, params.conversationId);

    if (!existing) {
      const acquired = await this.redisService
        .getClient()
        .set(key, JSON.stringify(lock), 'EX', this.ttlSeconds, 'NX');
      if (acquired !== 'OK') {
        const current = await this.getLock(
          params.tenantId,
          params.conversationId,
        );
        if (current) {
          throw new ConflictException({
            message: 'Conversation is locked by another agent',
            lock: current,
          });
        }
      }
    } else {
      await this.redisService
        .getClient()
        .set(key, JSON.stringify(lock), 'EX', this.ttlSeconds);
    }

    this.eventEmitter.emit('omni.conversation.lock_acquired', lock);
    return { acquired: true, lock };
  }

  async heartbeat(params: {
    tenantId: string;
    conversationId: string;
    agentId: string;
    agentName?: string | null;
  }): Promise<ConversationLock> {
    const existing = await this.getLock(params.tenantId, params.conversationId);
    if (!existing) {
      return (
        await this.acquireLock({
          ...params,
          source: 'heartbeat_reacquire',
        })
      ).lock;
    }

    if (existing.agentId !== params.agentId) {
      throw new ConflictException({
        message: 'Conversation is locked by another agent',
        lock: existing,
      });
    }

    const lock = this.buildLock({
      ...params,
      source: existing.source || 'heartbeat',
    });
    await this.redisService
      .getClient()
      .set(
        this.key(params.tenantId, params.conversationId),
        JSON.stringify(lock),
        'EX',
        this.ttlSeconds,
      );

    this.eventEmitter.emit('omni.conversation.lock_acquired', lock);
    return lock;
  }

  async releaseLock(params: {
    tenantId: string;
    conversationId: string;
    agentId: string;
  }): Promise<boolean> {
    const key = this.key(params.tenantId, params.conversationId);
    const script = `
      local current = redis.call("get", KEYS[1])
      if not current then return 0 end
      local decoded = cjson.decode(current)
      if decoded["agentId"] == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
    `;

    const released = Number(
      await this.redisService.getClient().eval(script, 1, key, params.agentId),
    );

    if (released > 0) {
      this.eventEmitter.emit('omni.conversation.lock_released', {
        tenantId: params.tenantId,
        conversationId: params.conversationId,
        agentId: params.agentId,
        releasedAt: new Date().toISOString(),
      });
    }

    return released > 0;
  }

  async takeover(params: {
    tenantId: string;
    conversationId: string;
    newAgentId: string;
    newAgentName?: string | null;
    reason?: string;
    force?: boolean;
  }): Promise<{
    previousLock: ConversationLock | null;
    newLock: ConversationLock;
  }> {
    await this.assertConversationExists(params.conversationId);

    const previousLock = await this.getLock(
      params.tenantId,
      params.conversationId,
    );
    if (
      previousLock &&
      previousLock.agentId !== params.newAgentId &&
      !params.force
    ) {
      throw new ConflictException({
        message: 'Conversation is locked by another agent',
        lock: previousLock,
      });
    }

    const newLock = this.buildLock({
      tenantId: params.tenantId,
      conversationId: params.conversationId,
      agentId: params.newAgentId,
      agentName: params.newAgentName,
      source: 'takeover',
    });

    await this.redisService
      .getClient()
      .set(
        this.key(params.tenantId, params.conversationId),
        JSON.stringify(newLock),
        'EX',
        this.ttlSeconds,
      );

    this.eventEmitter.emit('omni.conversation.takeover', {
      tenantId: params.tenantId,
      conversationId: params.conversationId,
      previousAgentId: previousLock?.agentId ?? null,
      previousAgentName: previousLock?.agentName ?? null,
      newAgentId: params.newAgentId,
      newAgentName: params.newAgentName ?? null,
      reason: params.reason,
      force: params.force ?? false,
      lockExpiresAt: newLock.expiresAt,
      occurredAt: new Date().toISOString(),
    });

    this.logger.log(
      `Conversation ${params.conversationId} taken over by ${params.newAgentId}`,
    );
    return { previousLock, newLock };
  }

  private key(tenantId: string, conversationId: string): string {
    return `lock:conv:${tenantId}:${conversationId}`;
  }

  private buildLock(params: {
    tenantId: string;
    conversationId: string;
    agentId: string;
    agentName?: string | null;
    source?: string;
  }): ConversationLock {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1000);
    return {
      tenantId: params.tenantId,
      conversationId: params.conversationId,
      agentId: params.agentId,
      agentName: params.agentName ?? null,
      lockedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      source: params.source ?? 'composer_focus',
    };
  }

  private parseLock(raw: string | null): ConversationLock | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ConversationLock;
    } catch {
      return null;
    }
  }

  private async assertConversationExists(
    conversationId: string,
  ): Promise<void> {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }
  }
}
