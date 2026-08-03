import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import {
  AssignmentSettingDocument,
  AssignmentSettingSchemaClass,
} from '../infrastructure/persistence/assignment-setting.schema';
import {
  AssignmentObjectType,
  AssignmentStrategy,
  normalizeStrategy,
} from '../domain/assignment.types';

/**
 * A narrower scope's partial override. Every field optional — an undefined field
 * inherits. Today the only producer is an omni channel
 * (`channel.config.routing`), but nothing in here knows that.
 */
export interface AssignmentConfigOverride {
  autoAssignEnabled?: boolean;
  defaultStrategy?: string;
  defaultMaxCapacity?: number;
  /** Strategy used when a preferred (sticky) assignee is unavailable and the attempt falls through. */
  stickyFallbackStrategy?: string;
  skillBasedRoutingEnabled?: boolean;
  /**
   * What to do when no candidate holds every required skill.
   * `lenient` (default) falls back to the full pool — availability over
   * precision. `strict` queues the entity instead of assigning it to
   * someone without the skill.
   */
  skillFallbackMode?: 'strict' | 'lenient';
  requireOnline?: boolean;
  preferPreviousAssignee?: boolean;
  previousAssigneeTimeoutHours?: number;
  previousAssigneeWaitMinutes?: number;
}

/** Fully resolved config — every decision field is concrete. */
export interface ResolvedAssignmentConfig {
  autoAssignEnabled: boolean;
  defaultStrategy: AssignmentStrategy;
  defaultGroupId: string | null;
  defaultMaxCapacity: number;
  fallbackOwnerId: string | null;
  stickyFallbackStrategy: AssignmentStrategy;
  skillBasedRoutingEnabled: boolean;
  skillFallbackMode: 'strict' | 'lenient';
  requireOnline: boolean;
  preferPreviousAssignee: boolean;
  previousAssigneeTimeoutHours: number;
  previousAssigneeWaitMinutes: number;
}

const HARD_DEFAULTS: ResolvedAssignmentConfig = {
  autoAssignEnabled: false,
  defaultStrategy: 'round-robin',
  defaultGroupId: null,
  defaultMaxCapacity: 10,
  fallbackOwnerId: null,
  stickyFallbackStrategy: 'round-robin',
  skillBasedRoutingEnabled: false,
  skillFallbackMode: 'lenient',
  requireOnline: false,
  preferPreviousAssignee: false,
  previousAssigneeTimeoutHours: 72,
  previousAssigneeWaitMinutes: 0,
};

/**
 * Resolve config field-by-field: `override ?? stored ?? hard default`.
 *
 * Per-field, not per-object, is the point: a channel that overrides only
 * `defaultStrategy` must keep inheriting the other nine fields. This is the one
 * seam every routing-decision setting flows through, so adding a field is a
 * single line here plus a line in the schema.
 *
 * Exported as a pure function so it can be unit-tested without a database —
 * this is the generalised form of omni's `mergeRoutingConfig()`, which was the
 * one part of the old configuration handling that was already right.
 */
export function mergeAssignmentConfig(
  stored: Partial<AssignmentSettingSchemaClass> | null | undefined,
  override?: AssignmentConfigOverride | null,
): ResolvedAssignmentConfig {
  const s = stored ?? {};
  const o = override ?? {};

  const pickNumber = (
    ...values: Array<number | undefined | null>
  ): number | undefined => {
    for (const v of values) {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  };

  return {
    autoAssignEnabled:
      o.autoAssignEnabled ??
      s.autoAssignEnabled ??
      HARD_DEFAULTS.autoAssignEnabled,
    defaultStrategy: normalizeStrategy(
      o.defaultStrategy ?? s.defaultStrategy,
      HARD_DEFAULTS.defaultStrategy,
    ),
    defaultGroupId: s.defaultGroupId ? String(s.defaultGroupId) : null,
    defaultMaxCapacity:
      pickNumber(o.defaultMaxCapacity, s.defaultMaxCapacity) ??
      HARD_DEFAULTS.defaultMaxCapacity,
    fallbackOwnerId: s.fallbackOwnerId ? String(s.fallbackOwnerId) : null,
    stickyFallbackStrategy: normalizeStrategy(
      o.stickyFallbackStrategy ?? s.stickyFallbackStrategy,
      HARD_DEFAULTS.stickyFallbackStrategy,
    ),
    skillBasedRoutingEnabled:
      o.skillBasedRoutingEnabled ??
      s.skillBasedRoutingEnabled ??
      HARD_DEFAULTS.skillBasedRoutingEnabled,
    skillFallbackMode:
      o.skillFallbackMode ??
      s.skillFallbackMode ??
      HARD_DEFAULTS.skillFallbackMode,
    requireOnline:
      o.requireOnline ?? s.requireOnline ?? HARD_DEFAULTS.requireOnline,
    preferPreviousAssignee:
      o.preferPreviousAssignee ??
      s.preferPreviousAssignee ??
      HARD_DEFAULTS.preferPreviousAssignee,
    previousAssigneeTimeoutHours:
      pickNumber(
        o.previousAssigneeTimeoutHours,
        s.previousAssigneeTimeoutHours,
      ) ?? HARD_DEFAULTS.previousAssigneeTimeoutHours,
    previousAssigneeWaitMinutes:
      pickNumber(
        o.previousAssigneeWaitMinutes,
        s.previousAssigneeWaitMinutes,
      ) ?? HARD_DEFAULTS.previousAssigneeWaitMinutes,
  };
}

/**
 * Loads and caches per-(tenant, objectType) settings.
 *
 * Settings are admin-edited a few times a day and read on every assignment, so
 * they are cached in-process. Invalidation is event-driven and fanned out over
 * Redis pub/sub — the pod that served the write is not necessarily the pod that
 * will serve the next decision — with the TTL as a backstop rather than the
 * primary mechanism.
 */
@Injectable()
export class AssignmentConfigService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AssignmentConfigService.name);

  private static readonly INVALIDATION_CHANNEL = 'assignment:config:invalidate';

  private readonly cache = new Map<
    string,
    { value: Partial<AssignmentSettingSchemaClass> | null; expiresAt: number }
  >();

  private readonly TTL_MS = 5 * 60_000;

  private subscriber?: Redis;

  constructor(
    @InjectModel(AssignmentSettingSchemaClass.name)
    private readonly model: Model<AssignmentSettingDocument>,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      this.subscriber = this.redis.duplicate();
      await this.subscriber.subscribe(
        AssignmentConfigService.INVALIDATION_CHANNEL,
      );
      this.subscriber.on('message', (_channel, message) => {
        if (!message || message === '*') {
          this.cache.clear();
          return;
        }
        // `<tenantId>:*` drops every objectType of one tenant — used when a
        // tenant-wide change, or a settings import, invalidates all of them.
        if (message.endsWith(':*')) {
          const prefix = message.slice(0, -1);
          for (const key of [...this.cache.keys()]) {
            if (key.startsWith(prefix)) this.cache.delete(key);
          }
          return;
        }
        this.cache.delete(message);
      });
    } catch (err: any) {
      // Non-fatal: the TTL still bounds staleness when pub/sub is unavailable.
      this.logger.error(
        `Failed to subscribe to assignment config invalidation: ${err.message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.subscriber) return;
    try {
      await this.subscriber.unsubscribe(
        AssignmentConfigService.INVALIDATION_CHANNEL,
      );
      await this.subscriber.quit();
    } catch {
      this.logger.debug('Failed to clean up assignment config subscriber');
    }
  }

  private cacheKey(tenantId: string, objectType: AssignmentObjectType): string {
    return `${tenantId}:${objectType}`;
  }

  /** Stored document for one (tenant, objectType), cached. Null when unset. */
  async load(
    tenantId: string,
    objectType: AssignmentObjectType,
  ): Promise<Partial<AssignmentSettingSchemaClass> | null> {
    const key = this.cacheKey(tenantId, objectType);
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    let value: Partial<AssignmentSettingSchemaClass> | null = null;
    try {
      value = await this.model
        .findOne({ tenantId, objectType })
        .lean<Partial<AssignmentSettingSchemaClass>>()
        .exec();
    } catch (err: any) {
      // Do not cache a failure — a transient DB blip must not pin defaults for
      // five minutes. Fall through with null and retry on the next decision.
      this.logger.error(
        `Failed to load assignment settings for ${key}: ${err.message}`,
      );
      return null;
    }

    this.cache.set(key, { value, expiresAt: now + this.TTL_MS });
    return value;
  }

  /** Stored settings merged with a narrower scope's override. */
  async resolve(
    tenantId: string,
    objectType: AssignmentObjectType,
    override?: AssignmentConfigOverride | null,
  ): Promise<ResolvedAssignmentConfig> {
    const stored = await this.load(tenantId, objectType);
    return mergeAssignmentConfig(stored, override);
  }

  async get(
    tenantId: string,
    objectType: AssignmentObjectType,
  ): Promise<ResolvedAssignmentConfig> {
    return this.resolve(tenantId, objectType, null);
  }

  async upsert(
    tenantId: string,
    objectType: AssignmentObjectType,
    patch: Record<string, unknown>,
  ): Promise<ResolvedAssignmentConfig> {
    const doc = await this.model
      .findOneAndUpdate(
        { tenantId, objectType },
        { $set: patch },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      )
      .lean<Partial<AssignmentSettingSchemaClass>>()
      .exec();
    await this.invalidate(tenantId, objectType);
    return mergeAssignmentConfig(doc, null);
  }

  /** Drop this pod's entry now, and tell every other pod to do the same. */
  async invalidate(
    tenantId?: string,
    objectType?: AssignmentObjectType,
  ): Promise<void> {
    if (tenantId && objectType) {
      this.cache.delete(this.cacheKey(tenantId, objectType));
    } else if (tenantId) {
      for (const key of [...this.cache.keys()]) {
        if (key.startsWith(`${tenantId}:`)) this.cache.delete(key);
      }
    } else {
      this.cache.clear();
    }

    const payload =
      tenantId && objectType
        ? this.cacheKey(tenantId, objectType)
        : tenantId
          ? `${tenantId}:*`
          : '*';

    try {
      await this.redis.publish(
        AssignmentConfigService.INVALIDATION_CHANNEL,
        payload,
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to publish assignment config invalidation (${payload}): ${err.message}`,
      );
    }
  }
}
