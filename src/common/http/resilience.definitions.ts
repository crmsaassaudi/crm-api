export const RESILIENCE_POLICIES = {
    facebook: {
        retries: 5,
        breakerThreshold: 3,
        timeout: 5000,
    },
    generic: {
        retries: 2,
        breakerThreshold: 5,
        timeout: 3000,
    },
    none: {},
};

export type ResilienceServiceType = keyof typeof RESILIENCE_POLICIES;

export interface ResilienceOptions {
    service: ResilienceServiceType;
    retries?: number;
    timeout?: number;
    breakerThreshold?: number;
    breakerResetMs?: number;
}
