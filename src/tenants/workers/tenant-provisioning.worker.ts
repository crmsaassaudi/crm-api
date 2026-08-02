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
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { ulid } from 'ulid';

const PROVISIONING_KEY_PREFIX = 'provisioning:';
const PROVISIONING_TTL = 86_400; // 24h
const TOTAL_STEPS = 10;

/**
 * What this attempt has built so far, so a failure knows what to undo.
 *
 * Rebuilt from scratch on every attempt rather than carried in the job data:
 * each attempt re-derives the world it finds (see the find-or-create steps),
 * so a stale tracker from a previous attempt would describe resources this one
 * did not create and must not delete.
 */
interface SagaState {
  aliasReserved: boolean;
  keycloakOrgId: string | null;
  keycloakOrgCreatedByThisJob: boolean;
  keycloakUserCreatedByThisJob: boolean;
  keycloakUserId: string | null;
  tenantId: string | null;
  localUserId: string | null;
  localUserCreatedByThisJob: boolean;
  botWorkspaceProvisioned: boolean;
}

const createSagaState = (): SagaState => ({
  aliasReserved: false,
  keycloakOrgId: null,
  keycloakOrgCreatedByThisJob: false,
  keycloakUserCreatedByThisJob: false,
  keycloakUserId: null,
  tenantId: null,
  localUserId: null,
  localUserCreatedByThisJob: false,
  botWorkspaceProvisioned: false,
});

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
    // `.finally()` returns a NEW promise that settles the same way as `task`.
    // BullMQ handles the rejection of `task` itself, but nothing was watching
    // this derived one — so every failed provisioning job raised an unhandled
    // rejection, which Node terminates the worker process for by default.
    task
      .finally(() => this.inFlight.delete(task))
      .catch(() => {
        /* reported by runJob; rethrown to BullMQ through `task` */
      });
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

    const saga = createSagaState();

    try {
      await this.updateStatus(provisioningId, {
        status: 'PROVISIONING',
        currentStep: 0,
        totalSteps: TOTAL_STEPS,
        stepLabel: 'Starting…',
      });

      // Phase 1: Keycloak
      await this.provisionKeycloakResources(provisioningId, data, saga);

      // Phase 2: MongoDB + bot workspace
      const { redirectUrl, localUser } = await this.provisionMongoResources(
        provisioningId,
        data,
        saga,
      );

      // ── Emit event for downstream listeners ─────────────────────────
      runWithTenantContext(this.cls, saga.tenantId!, () =>
        this.eventEmitter.emit(
          'tenant.created',
          new TenantCreatedEvent(
            saga.tenantId!,
            data.companyName,
            data.email,
            localUser.id as string,
            data.useCase,
            data.teamSize,
          ),
        ),
      );

      this.logger.log(
        `[${source}] Provisioning complete for "${data.companyName}" → ${redirectUrl}`,
      );
    } catch (error: unknown) {
      await this.runSagaRollback(
        error,
        data,
        saga,
        job,
        provisioningId,
        source,
      );
      throw error; // Let BullMQ handle retry
    }
  }

  /** Phase 1: reserve alias, create KC org, find-or-create KC user. */
  private async provisionKeycloakResources(
    provisioningId: string,
    data: TenantProvisioningJobData,
    saga: SagaState,
  ): Promise<void> {
    // Step 1: alias already reserved by producer
    saga.aliasReserved = true;
    await this.reportStep(provisioningId, 1);

    // Step 2: Keycloak Organization.
    //
    // Find-or-create, because an attempt that failed at a later step left this
    // one done. Keycloak rejects a second organization with the same alias, so
    // a blind create made every retry die here on a conflict that was really
    // evidence the step had already succeeded.
    const existingOrg = await this.keycloakAdminService.findOrganizationByAlias(
      data.alias,
    );
    if (existingOrg) {
      saga.keycloakOrgId = existingOrg.id;
      this.logger.log(`Reusing existing KC org ${saga.keycloakOrgId}`);
    } else {
      const kcOrg = await this.keycloakAdminService.createOrganization(
        data.companyName,
        data.alias,
      );
      saga.keycloakOrgId = kcOrg.id;
      saga.keycloakOrgCreatedByThisJob = true;
    }
    await this.reportStep(provisioningId, 2);

    // Step 3: Keycloak User
    let kcUser = await this.keycloakAdminService.findUserByEmail(data.email);
    if (kcUser) {
      saga.keycloakUserId = kcUser.id;
      this.logger.log(`Reusing existing KC user ${saga.keycloakUserId}`);
    } else {
      const password = data.password ?? this.generateTempPassword();
      kcUser = await this.keycloakAdminService.createUser(
        data.email,
        password,
        data.fullName,
      );
      saga.keycloakUserId = kcUser.id;
      saga.keycloakUserCreatedByThisJob = true;
      this.logger.log(`Created new KC user ${saga.keycloakUserId}`);
    }
    await this.reportStep(provisioningId, 3);

    // Step 4: Add user to KC organization
    const keycloakOrgId = saga.keycloakOrgId;
    const keycloakUserId = saga.keycloakUserId;
    await this.keycloakAdminService.addUserToOrganization(
      keycloakOrgId,
      keycloakUserId,
    );
    await this.reportStep(provisioningId, 4);
  }

  /** Phase 2: create MongoDB tenant, bot workspace, confirm alias, mark READY. */
  private async provisionMongoResources(
    provisioningId: string,
    data: TenantProvisioningJobData,
    saga: SagaState,
  ): Promise<{ redirectUrl: string; localUser: any }> {
    const spaceIdx = data.fullName.indexOf(' ');
    const firstName =
      spaceIdx > -1 ? data.fullName.slice(0, spaceIdx) : data.fullName;
    const lastName = spaceIdx > -1 ? data.fullName.slice(spaceIdx + 1) : '';

    // Whether the local user predates this job decides whether rollback may
    // delete it. Read before the upsert, which cannot tell us afterwards.
    const preexistingUser = await this.userRepository.findByEmail(data.email);
    saga.localUserCreatedByThisJob = !preexistingUser;

    // A previous attempt may already have committed this transaction and then
    // failed at step 8 or 9. `alias` is unique, so recreating the tenant threw
    // a duplicate key — every retry of a half-finished signup failed for a
    // reason unrelated to the one that stopped it. Adopt that row instead.
    const existingTenant = await this.tenantsRepository.findByAlias(data.alias);
    if (existingTenant) {
      // Only ever adopt a row this pipeline abandoned. A READY tenant on the
      // same alias is somebody's live workspace, and resuming onto it would
      // hand it to whoever asked for the name second.
      if (existingTenant.provisioningStatus === ProvisioningStatus.READY) {
        throw new Error(
          `Alias "${data.alias}" already belongs to a provisioned tenant`,
        );
      }
      this.logger.log(
        `Resuming provisioning onto existing tenant ${existingTenant.id} for alias "${data.alias}"`,
      );
    }

    const transactionalResult = await this.transactionManager.runInTransaction(
      async (session) => {
        if (
          existingTenant &&
          existingTenant.keycloakOrgId !== saga.keycloakOrgId
        ) {
          // Realigns a resumed row whose organization was recreated.
          await this.tenantsRepository.update(
            existingTenant.id,
            { keycloakOrgId: saga.keycloakOrgId! } as any,
            session,
          );
          existingTenant.keycloakOrgId = saga.keycloakOrgId!;
        }

        const tenant =
          existingTenant ??
          (await this.tenantsRepository.create(
            {
              keycloakOrgId: saga.keycloakOrgId!,
              alias: data.alias,
              name: data.companyName,
              ownerId: null as any,
              subscriptionPlan: data.plan ?? SubscriptionPlan.FREE,
              status: TenantStatus.ACTIVE,
              provisioningStatus: ProvisioningStatus.PROVISIONING,
              onboardingGoal: data.useCase,
            },
            session,
          ));

        // `upsertWithTenants` adds memberships with $addToSet on the whole
        // subdocument, and `joinedAt` differs between attempts — so a resumed
        // job would append a second OWNER membership for the same tenant.
        const alreadyMember = preexistingUser?.tenants?.some(
          (membership: { tenantId: string }) =>
            String(membership.tenantId) === String(tenant.id),
        );

        const localUser = await this.userRepository.upsertWithTenants(
          saga.keycloakUserId!,
          data.email,
          {
            firstName,
            lastName,
            provider: AuthProvidersEnum.email,
            platformRole: { id: PlatformRoleEnum.USER } as any,
            status: { id: StatusEnum.active } as any,
            keycloakId: saga.keycloakUserId!,
            onboardingStatus: 'COMPLETED',
          },
          alreadyMember
            ? []
            : [{ tenantId: tenant.id, roles: ['OWNER'], joinedAt: new Date() }],
          session,
        );
        await this.tenantsRepository.updateOwner(
          tenant.id,
          localUser.id as string,
          session,
        );
        return { tenant, localUser };
      },
    );

    const { tenant, localUser } = transactionalResult;
    const tenantId = tenant.id;
    saga.tenantId = tenantId;
    saga.localUserId = String(localUser.id);
    await this.reportStep(provisioningId, 5);
    await this.reportStep(provisioningId, 6);
    await this.reportStep(provisioningId, 7);

    // Step 8: Bot workspace. crm-bot keys the mapping on tenantId and returns
    // the existing workspace on a repeat call, so a resumed job reuses it.
    const botWorkspaceId =
      await this.crmBotWorkspaceProvisioningService.provisionWorkspace({
        tenantId,
        ownerEmail: data.email,
        ownerName: data.fullName,
        tenantName: data.companyName,
      });
    saga.botWorkspaceProvisioned = true;
    await this.tenantsRepository.update(tenantId, {
      botWorkspaceId,
    } as any);
    await this.reportStep(provisioningId, 8);

    // Step 9: Confirm alias reservation
    await this.aliasReservationRepository.confirm(data.alias);
    await this.reportStep(provisioningId, 9);

    // Step 10: Seed sample data placeholder
    await this.reportStep(provisioningId, 10);

    // Mark READY
    await this.tenantsRepository.update(tenantId, {
      provisioningStatus: ProvisioningStatus.READY,
    });

    const redirectUrl = this.getTenantLoginUrl(data.alias);
    await this.updateStatus(provisioningId, {
      status: 'READY',
      currentStep: TOTAL_STEPS,
      totalSteps: TOTAL_STEPS,
      stepLabel: 'Your workspace is ready!',
      tenantId,
      redirectUrl,
    });

    return { redirectUrl, localUser };
  }

  /**
   * Handle a failed attempt: mark the tenant, and compensate only once no
   * retry is coming.
   *
   * Compensation used to run on every failure while the job was still
   * rethrown for BullMQ to retry, so each attempt tore down what the next one
   * needed and then hit the leftovers it could not remove. Undoing work that
   * is about to be redone is not a rollback, it is a race — the two are only
   * both correct when nothing follows.
   */
  private async runSagaRollback(
    error: unknown,
    data: TenantProvisioningJobData,
    saga: SagaState,
    job: Job<TenantProvisioningJobData>,
    provisioningId: string,
    source: string,
  ): Promise<void> {
    const errMsg = error instanceof Error ? error.message : String(error);
    const willRetry = !this.isFinalAttempt(job);

    this.logger.error(
      `[${source}] Provisioning FAILED for "${data.companyName}": ${errMsg}` +
        (willRetry ? ' — retrying, keeping partial state' : ''),
      error instanceof Error ? error.stack : undefined,
    );

    // Recorded either way so an operator inspecting mid-retry sees the reason.
    if (saga.tenantId) {
      await this.safeRollback('Mark tenant FAILED', () =>
        this.tenantsRepository.update(saga.tenantId!, {
          provisioningStatus: ProvisioningStatus.FAILED,
          provisioningError: errMsg,
        } as any),
      );
    }

    if (willRetry) {
      await this.reportFailure(provisioningId, true);
      return;
    }

    await this.compensate(data, saga);
    await this.reportFailure(provisioningId, false);
  }

  /**
   * Undo everything this pipeline built, in reverse order of creation.
   *
   * Only called when the job is finished for good. An operator-triggered
   * `job.retry()` afterwards starts from a clean world, which is what makes
   * the resumable steps above and this teardown consistent with each other.
   */
  private async compensate(
    data: TenantProvisioningJobData,
    saga: SagaState,
  ): Promise<void> {
    if (saga.botWorkspaceProvisioned && saga.tenantId) {
      await this.safeRollback('Delete crm-bot workspace', () =>
        this.crmBotWorkspaceProvisioningService.deprovisionWorkspace(
          saga.tenantId!,
        ),
      );
    }
    // Before the tenant row goes, or the membership points at nothing and the
    // user is offered a workspace that 404s on every request.
    if (saga.localUserId && saga.tenantId) {
      if (saga.localUserCreatedByThisJob) {
        await this.safeRollback('Delete local user', () =>
          this.userRepository.removeIfExists(saga.localUserId!),
        );
      } else {
        await this.safeRollback('Remove tenant membership', () =>
          this.userRepository.removeTenantMembership(
            saga.localUserId!,
            saga.tenantId!,
          ),
        );
      }
    }
    if (saga.tenantId) {
      await this.safeRollback('Delete MongoDB tenant', () =>
        this.tenantsRepository.remove(saga.tenantId!),
      );
    }
    // Only organizations this attempt created: a resumed job adopts the one an
    // earlier attempt left behind, and deleting an adopted org on the way out
    // is still correct here because the tenant it belonged to is going too.
    if (saga.keycloakOrgId) {
      await this.safeRollback('Delete KC org', () =>
        this.keycloakAdminService.deleteOrganization(saga.keycloakOrgId!),
      );
    }
    if (saga.keycloakUserCreatedByThisJob && saga.keycloakUserId) {
      await this.safeRollback('Delete KC user', () =>
        this.keycloakAdminService.deleteUser(saga.keycloakUserId!),
      );
    }
    // Last: the alias is what a new signup competes for, and it must not open
    // up until the tenant row holding the same unique value is gone.
    if (saga.aliasReserved) {
      await this.safeRollback('Delete alias reservation', () =>
        this.aliasReservationRepository.delete(data.alias),
      );
    }
  }

  /**
   * True when BullMQ will not schedule another attempt.
   *
   * `attemptsStarted` counts the attempt in progress; `attemptsMade` only
   * increments once this one has failed, so it is one short here and is used
   * as a fallback for job objects that predate the field (tests, older jobs).
   */
  private isFinalAttempt(job: Job<TenantProvisioningJobData>): boolean {
    const maxAttempts = job.opts?.attempts ?? 1;
    const attemptsStarted =
      (job as { attemptsStarted?: number }).attemptsStarted ??
      (job.attemptsMade ?? 0) + 1;
    return attemptsStarted >= maxAttempts;
  }

  private async reportFailure(
    provisioningId: string,
    retryable: boolean,
  ): Promise<void> {
    await this.updateStatus(provisioningId, {
      status: 'FAILED',
      currentStep: 0,
      totalSteps: TOTAL_STEPS,
      stepLabel: 'Provisioning failed',
      error: 'Workspace setup failed. Our team has been notified.',
      retryable,
    });
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
      this.configService.get('keycloak.frontendUrl', { infer: true }) ??
      'https://crmsaudi.dev';
    const rootDomain =
      this.configService.get('app.rootDomain', { infer: true }) ??
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
