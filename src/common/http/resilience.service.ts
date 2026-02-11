import { Injectable, Logger } from '@nestjs/common';
import { retry, handleAll, circuitBreaker, wrap, ExponentialBackoff, ConsecutiveBreaker, IPolicy, IDefaultPolicyContext, timeout, TimeoutStrategy, noop } from 'cockatiel';
import { RESILIENCE_POLICIES, ResilienceOptions, ResilienceServiceType } from './resilience.definitions';
import { ClsService } from 'nestjs-cls';

@Injectable()
export class ResilienceService {
    private readonly logger = new Logger(ResilienceService.name);
    private readonly policies = new Map<string, IPolicy<IDefaultPolicyContext>>();

    constructor(private readonly cls: ClsService) {
        // Initialize default policy
        this.getPolicy('default');
    }

    public getPolicy(serviceName: string, overrideOptions?: Partial<ResilienceOptions>): IPolicy<IDefaultPolicyContext> {
        if (this.policies.has(serviceName)) {
            return this.policies.get(serviceName)!;
        }

        if (serviceName === 'none') {
            this.policies.set(serviceName, noop);
            return noop;
        }

        // 1. Lookup defaults from Registry
        const registryDefaults = RESILIENCE_POLICIES[serviceName as ResilienceServiceType] || RESILIENCE_POLICIES.generic;

        // 2. Merge with overrides
        const options: ResilienceOptions = {
            service: serviceName as ResilienceServiceType,
            ...registryDefaults,
            ...overrideOptions,
        };

        const { retries = 3, breakerThreshold = 5, breakerResetMs = 10000, timeout: timeoutMs = 10000 } = options;

        this.logger.log(`Creating policy for '${serviceName}': Retries=${retries}, Breaker=${breakerThreshold}, Timeout=${timeoutMs}ms`);

        // --- Policies ---

        // 1. Timeout Policy (Fail fast if slow)
        const timeoutPolicy = timeout(timeoutMs, TimeoutStrategy.Aggressive);

        // 2. Retry Policy (with Jitter)
        // full jitter: delay = random(0, base * 2^attempt)
        const backoff = new ExponentialBackoff({
            initialDelay: 200,
            maxDelay: 30000,
            exponent: 2,
            // Cockatiel default is decorrelated jitter, which is good. 
            // To match user request "delay = base * 2^attempt + random(0, 300)" roughly, standard exponential is fine.
            // We will stick to the default strict exponential backoff for now as it's robust.
        });

        const retryPolicy = retry(handleAll, { maxAttempts: retries, backoff });

        // 3. Circuit Breaker Policy
        const circuitBreakerPolicy = circuitBreaker(handleAll, {
            halfOpenAfter: breakerResetMs,
            breaker: new ConsecutiveBreaker(breakerThreshold),
        });

        // --- Logging & Telemetry ---

        const getContext = () => `[${serviceName}] [${this.cls.getId() || 'NO_ID'}]`;

        retryPolicy.onRetry((reason) => {
            const error = 'error' in reason ? reason.error : undefined;
            this.logger.warn(`${getContext()} [Retry] Attempt ${reason.attempt}. Error: ${error?.message}`);
        });

        circuitBreakerPolicy.onBreak((reason) => {
            const error = 'error' in reason ? reason.error : undefined;
            this.logger.error(`${getContext()} [CircuitBreaker] OPEN. Error: ${error?.message}`);
        });

        circuitBreakerPolicy.onReset(() => {
            this.logger.log(`${getContext()} [CircuitBreaker] CLOSED.`);
        });

        timeoutPolicy.onTimeout(() => {
            this.logger.error(`${getContext()} [Timeout] Request exceeded ${timeoutMs}ms`);
        });

        // --- Composition ---
        // Order: CircuitBreaker -> Retry -> Timeout -> Execute
        // If Circuit is open, fail immediately.
        // If Circuit is closed, try.
        // If fails, Retry catches it.
        // Timeout enforces overall limit per attempt (or overall? typically per attempt in many configs, but here we wrap retry around timeout or timeout around retry?)
        // Standard user request: "Timeout Policy: If API hangs, retry is useless." -> This implies timeout per attempt.
        // So: Wrap(Retry, CircuitBreaker, Timeout) -> means Retry calls CircuitBreaker calls Timeout calls Function.

        const policy = wrap(retryPolicy, circuitBreakerPolicy, timeoutPolicy);
        this.policies.set(serviceName, policy);

        return policy;
    }

    /**
     * @deprecated Use getPolicy('default') instead
     */
    public get policy() {
        return this.getPolicy('default');
    }
}
