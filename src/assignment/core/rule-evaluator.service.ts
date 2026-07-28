import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { AssignmentRuleRepository } from '../infrastructure/persistence/assignment-rule.repository';
import {
  AssignmentRule,
  RuleMatch,
  ruleMatchOf,
} from '../domain/assignment-rule';
import {
  AssignmentAttributes,
  RuleTrace,
  evaluateRule,
} from '../domain/condition-evaluator';
import { AssignmentObjectType } from '../domain/assignment.types';

export interface RuleEvaluationResult {
  match: RuleMatch | null;
  /** Every rule considered, in priority order — the dry-run explain output. */
  traces: RuleTrace[];
  /** Exact immutable inputs evaluated, used for reproducible policy snapshots. */
  rules: AssignmentRule[];
}

/**
 * Evaluates rules for one (tenant, objectType) against an attribute bag and
 * returns the first match in priority order.
 *
 * Rules are admin-edited a few times a day and evaluated on every inbound
 * message, so they are cached in-process with cross-pod invalidation. The old
 * omni evaluator had the same cache but only invalidated the pod that served
 * the write; the record engine had no cache at all and re-queried Mongo on
 * every decision.
 */
@Injectable()
export class AssignmentRuleEvaluatorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AssignmentRuleEvaluatorService.name);

  private static readonly INVALIDATION_CHANNEL = 'assignment:rules:invalidate';

  private readonly cache = new Map<
    string,
    { rules: AssignmentRule[]; expiresAt: number }
  >();

  private readonly TTL_MS = 60_000;

  private subscriber?: Redis;

  constructor(
    private readonly repository: AssignmentRuleRepository,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      this.subscriber = this.redis.duplicate();
      await this.subscriber.subscribe(
        AssignmentRuleEvaluatorService.INVALIDATION_CHANNEL,
      );
      this.subscriber.on('message', (_channel, message) => {
        if (!message || message === '*') {
          this.cache.clear();
          return;
        }
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
      this.logger.error(
        `Failed to subscribe to rule invalidation channel: ${err.message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.subscriber) return;
    try {
      await this.subscriber.unsubscribe(
        AssignmentRuleEvaluatorService.INVALIDATION_CHANNEL,
      );
      await this.subscriber.quit();
    } catch {
      // best-effort cleanup
    }
  }

  private cacheKey(tenantId: string, objectType: AssignmentObjectType): string {
    return `${tenantId}:${objectType}`;
  }

  async invalidate(
    tenantId: string,
    objectType?: AssignmentObjectType,
  ): Promise<void> {
    const payload = objectType
      ? this.cacheKey(tenantId, objectType)
      : `${tenantId}:*`;
    if (objectType) {
      this.cache.delete(payload);
    } else {
      const prefix = `${tenantId}:`;
      for (const key of [...this.cache.keys()]) {
        if (key.startsWith(prefix)) this.cache.delete(key);
      }
    }
    try {
      await this.redis.publish(
        AssignmentRuleEvaluatorService.INVALIDATION_CHANNEL,
        payload,
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to publish rule invalidation (${payload}): ${err.message}`,
      );
    }
  }

  private async enabledRules(
    tenantId: string,
    objectType: AssignmentObjectType,
  ): Promise<AssignmentRule[]> {
    const key = this.cacheKey(tenantId, objectType);
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return hit.rules;

    const rules = await this.repository.findEnabled(tenantId, objectType);
    this.cache.set(key, { rules, expiresAt: now + this.TTL_MS });
    return rules;
  }

  /**
   * First matching rule wins.
   *
   * @param collectTraces when true every rule is evaluated and reported, even
   *   after a match, so the dry-run explain shows what would have matched next.
   *   The hot path leaves it false and stops at the first match.
   */
  async evaluate(
    tenantId: string,
    objectType: AssignmentObjectType,
    attributes: AssignmentAttributes,
    collectTraces = false,
  ): Promise<RuleEvaluationResult> {
    const rules = await this.enabledRules(tenantId, objectType);
    const traces: RuleTrace[] = [];
    let match: RuleMatch | null = null;

    for (const rule of rules) {
      const trace = evaluateRule(rule, attributes);
      if (collectTraces) traces.push(trace);
      if (trace.matched && !match) {
        match = ruleMatchOf(rule);
        this.logger.debug(
          `Rule matched for ${objectType}: "${rule.name}" (priority=${rule.priority})`,
        );
        if (!collectTraces) {
          traces.push(trace);
          break;
        }
      }
    }

    return { match, traces, rules };
  }
}
