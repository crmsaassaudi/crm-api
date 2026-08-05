import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../redis/redis.tokens';

/**
 * The in-process settings cache, with cross-instance invalidation.
 *
 * What was wrong
 *
 * `CrmSettingsService` held a plain `Map` with a 30-second TTL and deleted the
 * entry on write. Correct on one process; wrong on every deployment that runs more
 * than one, which this one does. An admin changing a layout on instance A left
 * instance B serving the previous policy for up to 30 seconds — and for
 * `layout_settings` that is 30 seconds of masking and field-level security computed
 * from stale configuration, on whichever instance happens to take the next request.
 * A control that is briefly wrong on an unpredictable subset of servers is very
 * hard to tell apart from one that is simply broken.
 *
 * The codebase already had the right pattern (`AssignmentConfigService`,
 * `RuleEvaluatorService`, `SessionService`): a duplicated Redis connection
 * subscribed to an invalidation channel. This applies it to settings and keeps the
 * TTL as the backstop for when pub/sub is unavailable.
 *
 * Extracted from `CrmSettingsService` rather than added to it: that service already
 * owns lifecycle-stage mutation, list-view array operations and settings validation,
 * and cache coherence is a separate concern with its own lifecycle hooks.
 */
@Injectable()
export class SettingsCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettingsCacheService.name);
  private static readonly INVALIDATION_CHANNEL = 'crm-settings:invalidate';
  private static readonly TTL_MS = 30_000;

  private readonly entries = new Map<
    string,
    { value: unknown; expiresAt: number }
  >();

  private subscriber?: Redis;

  constructor(
    // Optional so unit tests and any Redis-less runtime keep working with a
    // process-local cache; the TTL still bounds staleness there.
    @Optional() @Inject(IOREDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.redis) return;
    try {
      this.subscriber = this.redis.duplicate();
      await this.subscriber.subscribe(
        SettingsCacheService.INVALIDATION_CHANNEL,
      );
      this.subscriber.on('message', (_channel, message) => {
        if (!message || message === '*') {
          this.entries.clear();
          return;
        }
        // `<tenantId>:*` clears every key of one tenant — what a settings import
        // or a tenant-wide reset needs.
        if (message.endsWith(':*')) {
          const prefix = message.slice(0, -1);
          for (const key of [...this.entries.keys()]) {
            if (key.startsWith(prefix)) this.entries.delete(key);
          }
          return;
        }
        this.entries.delete(message);
      });
    } catch (error) {
      // Non-fatal: without pub/sub the TTL still bounds staleness to 30s, which is
      // the behaviour that existed before. Logged at error level because the
      // difference matters and is otherwise invisible.
      this.logger.error(
        `Settings cache invalidation is process-local: could not subscribe to Redis (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.subscriber) return;
    try {
      await this.subscriber.unsubscribe(
        SettingsCacheService.INVALIDATION_CHANNEL,
      );
      this.subscriber.disconnect();
    } catch {
      // Shutting down; a failed unsubscribe changes nothing.
    }
  }

  get<T>(tenantId: string, key: string): T | undefined {
    const entry = this.entries.get(cacheKey(tenantId, key));
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(cacheKey(tenantId, key));
      return undefined;
    }
    return entry.value as T;
  }

  set(tenantId: string, key: string, value: unknown): void {
    this.entries.set(cacheKey(tenantId, key), {
      value,
      expiresAt: Date.now() + SettingsCacheService.TTL_MS,
    });
  }

  /** Drop one key locally and everywhere else. */
  async invalidate(tenantId: string, key: string): Promise<void> {
    this.entries.delete(cacheKey(tenantId, key));
    await this.publish(cacheKey(tenantId, key));
  }

  /** Drop every key of one tenant, locally and everywhere else. */
  async invalidateTenant(tenantId: string): Promise<void> {
    const prefix = `${tenantId}:`;
    for (const existing of [...this.entries.keys()]) {
      if (existing.startsWith(prefix)) this.entries.delete(existing);
    }
    await this.publish(`${tenantId}:*`);
  }

  private async publish(payload: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.publish(
        SettingsCacheService.INVALIDATION_CHANNEL,
        payload,
      );
    } catch (error) {
      // The local entry is already gone, so this instance is correct. Other
      // instances fall back to the TTL.
      this.logger.warn(
        `Could not publish settings invalidation (${payload}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

const cacheKey = (tenantId: string, key: string): string =>
  `${tenantId}:${key}`;
