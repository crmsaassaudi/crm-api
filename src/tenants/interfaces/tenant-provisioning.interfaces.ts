import { SubscriptionPlan } from '../domain/tenant';

/**
 * Payload for the tenant-provisioning BullMQ job.
 * Shared between Producer (enqueue) and Worker (process).
 */
export interface TenantProvisioningJobData {
  /** Unique provisioning tracking ID (used as Redis key for polling) */
  provisioningId: string;

  /** MongoDB User ID — null for SLG (user may not exist yet) */
  userId: string | null;

  /** Admin email for the new tenant */
  email: string;

  /** Admin full name (firstName + lastName) */
  fullName: string;

  /** Company / Organization display name */
  companyName: string;

  /** Auto-generated subdomain alias (e.g. "acme-corp") */
  alias: string;

  /** Subscription tier for the new tenant */
  plan: SubscriptionPlan;

  /** Password — only set for PLG flow; SLG uses Keycloak actions */
  password?: string;

  /** User-selected use case from onboarding UI (PLG only) */
  useCase?: string;

  /**
   * Headcount bracket from the onboarding wizard (PLG only).
   *
   * Decides whether the seeder builds an org tree at all. It was asked for and
   * then dropped on the floor, so every tenant got the same single-unit tree
   * regardless of answer — a 300-person company and a solo founder both landed
   * on one headquarters with nothing under it.
   */
  teamSize?: string;

  /** Origin of the provisioning request */
  source: 'PLG' | 'SLG';
}

/**
 * Shape of the provisioning status stored in Redis for frontend polling.
 */
export interface ProvisioningStatusPayload {
  status: 'QUEUED' | 'PROVISIONING' | 'READY' | 'FAILED';
  currentStep: number;
  totalSteps: number;
  stepLabel: string;
  tenantId?: string;
  redirectUrl?: string;
  error?: string;
  retryable?: boolean;
}
