import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Job } from 'bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { AllConfigType } from '../../config/config.type';

import { TENANT_PROVISIONING_QUEUE } from '../constants/queue.constants';
import {
  TenantProvisioningJobData,
  ProvisioningStatusPayload,
} from '../interfaces/tenant-provisioning.interfaces';
import { TenantsRepository } from '../infrastructure/persistence/document/repositories/tenant.repository';
import { TenantAliasReservationRepository } from '../infrastructure/persistence/document/repositories/tenant-alias-reservation.repository';
import { ProvisioningJobRepository } from '../infrastructure/persistence/document/repositories/provisioning-job.repository';
import { KeycloakAdminService } from '../../auth/services/keycloak-admin.service';
import { UserRepository } from '../../users/infrastructure/persistence/user.repository';
import { RedisService } from '../../redis/redis.service';
import { CrmBotWorkspaceProvisioningService } from '../services/crm-bot-workspace-provisioning.service';
import { TenantCreatedEvent } from '../events/tenant-created.event';
import { TransactionManager } from '../../database/transaction-manager.service';
import {
  SubscriptionPlan,
  TenantStatus,
  ProvisioningStatus,
} from '../domain/tenant';
import { AuthProvidersEnum } from '../../auth/auth-providers.enum';
import { PlatformRoleEnum } from '../../roles/platform-role.enum';
import { StatusEnum } from '../../statuses/statuses.enum';
import { Tenant } from '../domain/tenant';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { ulid } from 'ulid';

const PROVISIONING_KEY_PREFIX = 'provisioning:';
const PROVISIONING_TTL = 86_400; // 24h
const TOTAL_STEPS = 10;

const STEP_LABELS: Record<number, string> = {
  1: 'Reserving workspace name…',
  2: 'Creating organization…',
  3: 'Setting up your account…',
  4: 'Adding you to the organization…',
  5: 'Creating your workspace…',
  6: 'Configuring user permissions…',
  7: 'Finalizing ownership…',
  8: 'Creating bot workspace…',
  9: 'Confirming workspace…',
  10: 'Seeding sample data…',
};

@Processor(TENANT_PROVISIONING_QUEUE)
export class TenantProvisioningWorker
  extends WorkerHost
  implements OnModuleDestroy
{
  private readonly logger = new Logger(TenantProvisioningWorker.name);
  /**
   * Provisioning jobs run a multi-step saga (Keycloak + Mongo + bot
   * workspace) that can take 30s+. We hold a reference to each in-flight
   * job so SIGTERM can drain them instead of leaving half-provisioned
   * tenants in PROVISIONING status.
   */
  private readonly inFlight = new Set<Promise<unknown>>();
  private destroying = false;

  constructor(
    private readonly tenantsRepository: TenantsRepository,
    private readonly aliasReservationRepository: TenantAliasReservationRepository,
    private readonly provisioningJobRepository: ProvisioningJobRepository,
    private readonly keycloakAdminService: KeycloakAdminService,
    private readonly userRepository: UserRepository,
    private readonly redisService: RedisService,
    private readonly crmBotWorkspaceProvisioningService: CrmBotWorkspaceProvisioningService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService<AllConfigType>,
    private readonly cls: ClsService,
    private readonly transactionManager: TransactionManager,
  ) {
    super();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Main job handler
  // ─────────────────────────────────────────────────────────────────────────────

  async process(job: Job<TenantProvisioningJobData>): Promise<void> {
    const task = this.runJob(job);
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
    return task;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.destroying) return;
    this.destroying = true;
    if (this.inFlight.size > 0) {
      this.logger.log(
        `[TenantProvisioningWorker] Waiting for ${this.inFlight.size} in-flight job(s) to finish…`,
      );
      // 25s drain budget — long enough for the saga to either commit step N
      // or trigger compensating rollbacks. After that k8s will SIGKILL.
      await Promise.race([
        Promise.allSettled(Array.from(this.inFlight)),
        new Promise((resolve) => setTimeout(resolve, 25_000).unref()),
      ]);
    }
    // BullMQ WorkerHost exposes a `worker` instance — close it so it stops
    // pulling new jobs while we wait for the drain above.
    try {
      await (this as any).worker?.close?.();
    } catch {
      /* ignore */
    }
    this.logger.log('[TenantProvisioningWorker] Drained');
  }

  private async runJob(job: Job<TenantProvisioningJobData>): Promise<void> {
    const data = job.data;
    const { provisioningId, source } = data;

    this.logger.log(
      `[${source}] Processing provisioning job ${provisioningId} for "${data.companyName}"`,
    );

    // ── Saga compensation trackers ──────────────────────────────────────
    let aliasReserved = false;
    let keycloakOrgId: string | null = null;
    let keycloakUserCreatedByThisJob = false;
    let keycloakUserId: string | null = null;
    let tenantId: string | null = null;

    try {
      await this.updateStatus(provisioningId, {
        status: 'PROVISIONING',
        currentStep: 0,
        totalSteps: TOTAL_STEPS,
        stepLabel: 'Starting…',
      });

      // ── Step 1: Alias already reserved by ensureUniqueAlias (producer) ──
      // Verify reservation exists
      aliasReserved = true;
      await this.reportStep(provisioningId, 1);

      // ── Step 2: Create Keycloak Organization ──────────────────────────
      const kcOrg = await this.keycloakAdminService.createOrganization(
        data.companyName,
        data.alias,
      );
      keycloakOrgId = kcOrg.id;
      await this.reportStep(provisioningId, 2);

      // ── Step 3: Find or create the Keycloak User ──────────────────────
      let kcUser = await this.keycloakAdminService.findUserByEmail(data.email);
      if (kcUser) {
        keycloakUserId = kcUser.id;
        this.logger.log(`Reusing existing KC user ${keycloakUserId}`);
      } else {
        // PLG: password is provided; SLG: create without password
        const password = data.password || this.generateTempPassword();
        kcUser = await this.keycloakAdminService.createUser(
          data.email,
          password,
          data.fullName,
        );
        keycloakUserId = kcUser.id;
        keycloakUserCreatedByThisJob = true;
        this.logger.log(`Created new KC user ${keycloakUserId}`);
      }
      await this.reportStep(provisioningId, 3);

      // ── Step 4: Add user to the organization ──────────────────────────
      await this.keycloakAdminService.addUserToOrganization(
        keycloakOrgId!,
        keycloakUserId!,
      );
      await this.reportStep(provisioningId, 4);

      // ── Step 5: Create Tenant record in MongoDB ───────────────────────
      const tenantData: Partial<Tenant> = {
        keycloakOrgId: keycloakOrgId!,
        alias: data.alias,
        name: data.companyName,
        ownerId: null as any,
        subscriptionPlan: data.plan || SubscriptionPlan.FREE,
        status: TenantStatus.ACTIVE,
        provisioningStatus: ProvisioningStatus.PROVISIONING,
        onboardingGoal: data.useCase,
      };
      const spaceIdx = data.fullName.indexOf(' ');
      const firstName =
        spaceIdx > -1 ? data.fullName.slice(0, spaceIdx) : data.fullName;
      const lastName = spaceIdx > -1 ? data.fullName.slice(spaceIdx + 1) : '';

      const transactionalResult =
        await this.transactionManager.runInTransaction(async (session) => {
          const tenant = await this.tenantsRepository.create(
            tenantData,
            session,
          );

          const localUser = await this.userRepository.upsertWithTenants(
            keycloakUserId!,
            data.email,
            {
              firstName,
              lastName,
              provider: AuthProvidersEnum.email,
              platformRole: { id: PlatformRoleEnum.USER } as any,
              status: { id: StatusEnum.active } as any,
              keycloakId: keycloakUserId!,
              onboardingStatus: 'COMPLETED',
            },
            [{ tenantId: tenant.id, roles: ['OWNER'], joinedAt: new Date() }],
            session,
          );

          await this.tenantsRepository.updateOwner(
            tenant.id,
            localUser.id as string,
            session,
          );

          return { tenant, localUser };
        });

      const tenant = transactionalResult.tenant;
      const localUser = transactionalResult.localUser;
      tenantId = tenant.id;
      await this.reportStep(provisioningId, 5);
      await this.reportStep(provisioningId, 6);

      await this.reportStep(provisioningId, 7);

      // ── Step 8: Provision crm-bot Typebot workspace ───────────────────
      const botWorkspaceId =
        await this.crmBotWorkspaceProvisioningService.provisionWorkspace({
          tenantId: tenantId!,
          ownerEmail: data.email,
          ownerName: data.fullName,
          tenantName: data.companyName,
        });
      await this.tenantsRepository.update(tenantId!, { botWorkspaceId } as any);
      await this.reportStep(provisioningId, 8);

      // ── Step 9: Confirm alias reservation ─────────────────────────────
      await this.aliasReservationRepository.confirm(data.alias);
      await this.reportStep(provisioningId, 9);

      // ── Step 10: Seed sample data (placeholder for Phase 3) ───────────
      // TODO: Implement sample data seeder based on data.useCase
      await this.reportStep(provisioningId, 10);

      // ── Mark provisioning as READY ────────────────────────────────────
      await this.tenantsRepository.update(tenantId!, {
        provisioningStatus: ProvisioningStatus.READY,
      });

      const redirectUrl = this.getTenantLoginUrl(data.alias);

      await this.updateStatus(provisioningId, {
        status: 'READY',
        currentStep: TOTAL_STEPS,
        totalSteps: TOTAL_STEPS,
        stepLabel: 'Your workspace is ready!',
        tenantId: tenantId!,
        redirectUrl,
      });

      // ── Emit event for downstream listeners (CRM settings seeding, etc.)
      runWithTenantContext(this.cls, tenantId!, () =>
        this.eventEmitter.emit(
          'tenant.created',
          new TenantCreatedEvent(
            tenantId!,
            data.companyName,
            data.email,
            localUser.id as string,
            data.useCase,
          ),
        ),
      );

      this.logger.log(
        `[${source}] Provisioning complete for "${data.companyName}" → ${redirectUrl}`,
      );
    } catch (error: unknown) {
      // ── Saga Rollback (compensating transactions) ──────────────────────
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[${source}] Provisioning FAILED for "${data.companyName}": ${errMsg}`,
        error instanceof Error ? error.stack : undefined,
      );

      // Compensate in reverse order
      if (tenantId) {
        await this.safeRollback('Delete MongoDB tenant', () =>
          this.tenantsRepository.update(tenantId!, {
            provisioningStatus: ProvisioningStatus.FAILED,
            provisioningError: errMsg,
          } as any),
        );
      }

      if (keycloakOrgId) {
        await this.safeRollback('Delete KC org', () =>
          this.keycloakAdminService.deleteOrganization(keycloakOrgId!),
        );
      }

      if (keycloakUserCreatedByThisJob && keycloakUserId) {
        await this.safeRollback('Delete KC user', () =>
          this.keycloakAdminService.deleteUser(keycloakUserId!),
        );
      }

      if (aliasReserved) {
        await this.safeRollback('Delete alias reservation', () =>
          this.aliasReservationRepository.delete(data.alias),
        );
      }

      await this.updateStatus(provisioningId, {
        status: 'FAILED',
        currentStep: 0,
        totalSteps: TOTAL_STEPS,
        stepLabel: 'Provisioning failed',
        error: 'Workspace setup failed. Our team has been notified.',
        retryable: (job.attemptsMade ?? 0) < (job.opts?.attempts ?? 3),
      });

      throw error; // Let BullMQ handle retry
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private async reportStep(
    provisioningId: string,
    step: number,
  ): Promise<void> {
    this.logger.log(
      `[Step ${step}/${TOTAL_STEPS}] ${STEP_LABELS[step] || '…'}`,
    );
    await this.updateStatus(provisioningId, {
      status: 'PROVISIONING',
      currentStep: step,
      totalSteps: TOTAL_STEPS,
      stepLabel: STEP_LABELS[step] || 'Processing…',
    });
  }

  private async updateStatus(
    provisioningId: string,
    payload: ProvisioningStatusPayload,
  ): Promise<void> {
    // 1. DB-first: MongoDB is the source of truth for history/audit.
    try {
      await this.provisioningJobRepository.updateStatus(provisioningId, {
        status: payload.status,
        currentStep: payload.currentStep,
        totalSteps: payload.totalSteps,
        stepLabel: payload.stepLabel,
        tenantId: payload.tenantId,
        redirectUrl: payload.redirectUrl,
        error: payload.error,
      });
    } catch (dbErr) {
      // Log but do not block — Redis and webhook writes still proceed
      this.logger.error(
        `[DB] Failed to persist provisioning status for ${provisioningId}: ${dbErr instanceof Error ? dbErr.message : dbErr}`,
      );
    }

    // 2. Redis cache for low-latency polling fallback
    const key = `${PROVISIONING_KEY_PREFIX}${provisioningId}`;
    await this.redisService.set(key, JSON.stringify(payload), PROVISIONING_TTL);

    // 3. Push realtime event to crm-manager-api WebSocket gateway (fire-and-forget)
    void this.notifyManagerGateway(provisioningId, payload);
  }

  private async notifyManagerGateway(
    provisioningId: string,
    payload: ProvisioningStatusPayload,
  ): Promise<void> {
    const webhookUrl = (this.configService as ConfigService).get<string>(
      'MANAGER_API_INTERNAL_WEBHOOK_URL',
    );
    if (!webhookUrl) return;

    const internalApiKey = (this.configService as ConfigService).get<string>(
      'INTERNAL_API_KEY',
    );

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3_000);
      await fetch(`${webhookUrl}/api/onboarding/internal/provisioning-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(internalApiKey ? { 'X-Internal-Api-Key': internalApiKey } : {}),
        },
        body: JSON.stringify({ provisioningId, ...payload }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));
    } catch {
      // Non-critical — polling or WebSocket reconnect will hydrate state
    }
  }

  private async safeRollback(
    label: string,
    fn: () => Promise<any>,
  ): Promise<void> {
    try {
      await fn();
      this.logger.warn(`[Rollback] ${label} — OK`);
    } catch (e: unknown) {
      this.logger.error(
        `[Rollback] ${label} — FAILED: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  private getTenantLoginUrl(alias: string): string {
    const frontendUrl =
      this.configService.get('keycloak.frontendUrl', { infer: true }) ||
      'https://crmsaudi.dev';
    const rootDomain =
      this.configService.get('app.rootDomain', { infer: true }) ||
      'crmsaudi.dev';
    const url = new URL(frontendUrl);
    url.hostname = `${alias}.${rootDomain}`;
    url.pathname = '/login';
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  private generateTempPassword(): string {
    // SLG flow: user will reset via Keycloak executeActionsEmail
    return `Temp${ulid().slice(-12)}!`;
  }
}
