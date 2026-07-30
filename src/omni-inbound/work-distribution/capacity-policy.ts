const DEFAULT_CHANNEL_WEIGHTS: Record<string, number> = {
  voice: 5,
  phone: 5,
  video: 5,
  email: 2,
  whatsapp: 1,
  livechat: 1,
  facebook: 1,
  instagram: 1,
  telegram: 1,
  zalo: 1,
  tiktok: 1,
};

export type CapacityPolicyOverrides = {
  capacityWeights?: Record<string, number>;
  afterContactWorkSeconds?: Record<string, number>;
};

function sanitizeNumberMap(
  value: unknown,
  min: number,
): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric >= min) {
      result[key.toLowerCase()] = numeric;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

export function normalizeCapacityPolicy(
  value: unknown,
): CapacityPolicyOverrides {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    capacityWeights: sanitizeNumberMap(
      raw.capacityWeights ?? raw.channelWeights,
      0.1,
    ),
    afterContactWorkSeconds: sanitizeNumberMap(
      raw.afterContactWorkSeconds ?? raw.acwSecondsByChannel,
      0,
    ),
  };
}

export function mergeCapacityPolicies(
  ...policies: CapacityPolicyOverrides[]
): CapacityPolicyOverrides {
  return {
    capacityWeights: Object.assign(
      {},
      ...policies.map((policy) => policy.capacityWeights ?? {}),
    ),
    afterContactWorkSeconds: Object.assign(
      {},
      ...policies.map((policy) => policy.afterContactWorkSeconds ?? {}),
    ),
  };
}

export function resolveCapacityWeight(
  channelType: string,
  overrides?: Record<string, number>,
): number {
  const normalizedChannel = channelType.toLowerCase();
  const configured =
    overrides?.[normalizedChannel] ??
    DEFAULT_CHANNEL_WEIGHTS[normalizedChannel] ??
    1;
  return Number.isFinite(configured) && configured >= 0.1 ? configured : 1;
}

export function resolveAfterContactWorkSeconds(
  channelType: string,
  overrides?: Record<string, number>,
): number {
  const normalizedChannel = channelType.toLowerCase();
  const configured = overrides?.[normalizedChannel];
  if (Number.isFinite(configured) && configured! >= 0) return configured!;
  return ['voice', 'phone'].includes(normalizedChannel) ? 60 : 30;
}
