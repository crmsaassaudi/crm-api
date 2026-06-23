export const RESILIENCE_POLICIES = {
  facebook: {
    retries: 5,
    breakerThreshold: 3,
    timeout: 5000,
  },
  // T-033: WhatsApp Cloud API — higher timeout for media uploads
  whatsapp: {
    retries: 3,
    breakerThreshold: 5,
    timeout: 10000,
    breakerResetMs: 30000,
  },
  // T-033: Instagram uses Meta Graph API (same infra as Facebook)
  instagram: {
    retries: 5,
    breakerThreshold: 3,
    timeout: 5000,
  },
  // T-034: Zalo OA API — moderate reliability, Vietnamese CDN latency
  zalo: {
    retries: 3,
    breakerThreshold: 5,
    timeout: 8000,
    breakerResetMs: 20000,
  },
  // T-034: Telegram Bot API — generally fast and reliable
  telegram: {
    retries: 3,
    breakerThreshold: 5,
    timeout: 8000,
  },
  // T-034: TikTok Business API — newer, less stable
  tiktok: {
    retries: 3,
    breakerThreshold: 5,
    timeout: 10000,
    breakerResetMs: 30000,
  },
  // T-034: Bot engine (Typebot/Dialogflow) — long processing time
  bot: {
    retries: 2,
    breakerThreshold: 3,
    timeout: 15000,
    breakerResetMs: 60000,
  },
  gemini: {
    retries: 2,
    breakerThreshold: 3,
    timeout: 30000,
  },
  openai: {
    retries: 2,
    breakerThreshold: 3,
    timeout: 30000,
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
