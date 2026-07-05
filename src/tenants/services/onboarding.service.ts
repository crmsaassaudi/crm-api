import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { ProvisioningStatusPayload } from '../interfaces/tenant-provisioning.interfaces';

const ONBOARDING_KEY_PREFIX = 'onboarding:';
const PROVISIONING_KEY_PREFIX = 'provisioning:';
const ONBOARDING_TTL = 86_400; // 24 hours — aligned with orphan cleanup cron

export interface OnboardingSessionData {
  step: number;
  companyName?: string;
  teamSize?: string;
  useCase?: string;
  startedAt: string;
}

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(private readonly redisService: RedisService) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // Onboarding Session (multi-step form state in Redis)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a new onboarding session for a user (called after Step 1).
   */
  async createSession(userId: string): Promise<OnboardingSessionData> {
    const data: OnboardingSessionData = {
      step: 2,
      startedAt: new Date().toISOString(),
    };
    const key = `${ONBOARDING_KEY_PREFIX}${userId}`;
    await this.redisService.set(key, JSON.stringify(data), ONBOARDING_TTL);
    this.logger.log(`Onboarding session created for user ${userId}`);
    return data;
  }

  /**
   * Read the current onboarding session (for hydration on F5/refresh).
   */
  async getSession(userId: string): Promise<OnboardingSessionData | null> {
    const key = `${ONBOARDING_KEY_PREFIX}${userId}`;
    const raw = await this.redisService.get<string>(key);
    if (!raw) return null;

    try {
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
  }

  /**
   * Merge partial context data into the existing session (progressive profiling).
   */
  async updateSession(
    userId: string,
    update: Partial<Omit<OnboardingSessionData, 'startedAt'>>,
  ): Promise<OnboardingSessionData> {
    const existing = await this.getSession(userId);
    if (!existing) {
      throw new NotFoundException('No active onboarding session found');
    }

    const merged: OnboardingSessionData = {
      ...existing,
      ...update,
    };

    // Auto-advance step once company name and team size are captured
    if (merged.companyName && merged.teamSize) {
      merged.step = 3; // Ready to complete when useCase also filled
    }

    const key = `${ONBOARDING_KEY_PREFIX}${userId}`;
    await this.redisService.set(key, JSON.stringify(merged), ONBOARDING_TTL);
    return merged;
  }

  /**
   * Delete the onboarding session after provisioning is queued.
   */
  async deleteSession(userId: string): Promise<void> {
    const key = `${ONBOARDING_KEY_PREFIX}${userId}`;
    await this.redisService.del(key);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Provisioning Status (polled by frontend during loading screen)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Read the current provisioning status for a given provisioningId.
   */
  async getProvisioningStatus(
    provisioningId: string,
  ): Promise<ProvisioningStatusPayload | null> {
    const key = `${PROVISIONING_KEY_PREFIX}${provisioningId}`;
    const raw = await this.redisService.get<string>(key);
    if (!raw) return null;

    try {
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
  }

  /**
   * Set initial QUEUED status when a provisioning job is enqueued.
   */
  async setProvisioningQueued(provisioningId: string): Promise<void> {
    const key = `${PROVISIONING_KEY_PREFIX}${provisioningId}`;
    const payload: ProvisioningStatusPayload = {
      status: 'QUEUED',
      currentStep: 0,
      totalSteps: 9,
      stepLabel: 'Queued — your workspace will be ready shortly…',
    };
    await this.redisService.set(key, JSON.stringify(payload), ONBOARDING_TTL);
  }
}
