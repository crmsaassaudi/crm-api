import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TenantsRepository } from './infrastructure/persistence/document/repositories/tenant.repository';
import { TenantAliasReservationRepository } from './infrastructure/persistence/document/repositories/tenant-alias-reservation.repository';
import { RegisterTenantDto } from './dto/register-tenant.dto';
import { OnboardExistingUserDto } from './dto/onboard-existing-user.dto';
import { Tenant, SubscriptionPlan, TenantStatus } from './domain/tenant';
import { User } from '../users/domain/user';
import { KeycloakAdminService } from '../auth/services/keycloak-admin.service';
import { PlatformRoleEnum } from '../roles/platform-role.enum';
import { AuthProvidersEnum } from '../auth/auth-providers.enum';
import { StatusEnum } from '../statuses/statuses.enum';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantCreatedEvent } from './events/tenant-created.event';
import { UserRepository } from '../users/infrastructure/persistence/user.repository';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../config/config.type';

export interface RegisterTenantResult {
  tenantId: string;
  alias: string;
  organizationName: string;
  keycloakOrgId: string;
  loginUrl: string;
}

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    private readonly tenantsRepository: TenantsRepository,
    private readonly aliasReservationRepository: TenantAliasReservationRepository,
    private readonly keycloakAdminService: KeycloakAdminService,
    private readonly userRepository: UserRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService<AllConfigType>,
  ) {}

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

  // ─────────────────────────────────────────────────────────────────────────────
  // Saga: POST /api/auth/register
  // ─────────────────────────────────────────────────────────────────────────────

  async register(dto: RegisterTenantDto): Promise<RegisterTenantResult> {
    const {
      email,
      password,
      fullName,
      organizationName,
      organizationAlias: alias,
    } = dto;

    // ── Saga compensation trackers ─────────────────────────────────────────────
    let aliasReserved = false;
    let keycloakOrgId: string | null = null;
    let keycloakUserCreatedByThisSaga = false;
    let keycloakUserId: string | null = null;

    const stepLog = (step: number, msg: string) =>
      this.logger.log(`[Saga][Step ${step}] ${msg}`);
    const stepErr = (step: number, err: unknown) =>
      this.logger.error(
        `[Saga][Step ${step} FAILED] ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );

    try {
      // ── Step 1: Atomic alias reservation ──────────────────────────────────────
      try {
        await this.aliasReservationRepository.reserve(alias);
        aliasReserved = true;
        stepLog(1, `Alias "${alias}" reserved`);
      } catch (e) {
        stepErr(1, e);
        throw e;
      }

      // ── Step 2: Create Keycloak Organization ──────────────────────────────────
      try {
        const kcOrg = await this.keycloakAdminService.createOrganization(
          organizationName,
          alias,
        );
        keycloakOrgId = kcOrg.id;
        stepLog(2, `KC org created: ${keycloakOrgId}`);
      } catch (e) {
        stepErr(2, e);
        throw e;
      }

      // ── Step 3: Find or create the Keycloak User ──────────────────────────────
      try {
        let kcUser = await this.keycloakAdminService.findUserByEmail(email);
        if (kcUser) {
          keycloakUserId = kcUser.id;
          stepLog(3, `Reusing existing KC user ${keycloakUserId} for ${email}`);
        } else {
          kcUser = await this.keycloakAdminService.createUser(
            email,
            password,
            fullName,
          );
          keycloakUserId = kcUser.id;
          keycloakUserCreatedByThisSaga = true;
          stepLog(3, `KC user created: ${keycloakUserId}`);
        }
      } catch (e) {
        stepErr(3, e);
        throw e;
      }

      // ── Step 4: Add user to the organization ──────────────────────────────────
      try {
        await this.keycloakAdminService.addUserToOrganization(
          keycloakOrgId!,
          keycloakUserId!,
        );
        stepLog(4, `User ${keycloakUserId} added to org ${keycloakOrgId}`);
      } catch (e) {
        stepErr(4, e);
        throw e;
      }

      // ── Step 6: Create Tenant record in MongoDB ───────────────────────────────
      let tenant: Tenant;
      try {
        const tenantData: Partial<Tenant> = {
          keycloakOrgId: keycloakOrgId!,
          alias,
          name: organizationName,
          ownerId: null as any,
          subscriptionPlan: SubscriptionPlan.FREE,
          status: TenantStatus.ACTIVE,
        };
        tenant = await this.tenantsRepository.create(tenantData);
        stepLog(6, `Tenant created in MongoDB: ${tenant.id}`);
      } catch (e) {
        stepErr(6, e);
        throw e;
      }

      // ── Step 7: Upsert User in MongoDB & add OWNER membership ─────────────────
      let localUser: any;
      try {
        const spaceIdx = fullName.indexOf(' ');
        const firstName =
          spaceIdx > -1 ? fullName.slice(0, spaceIdx) : fullName;
        const lastName = spaceIdx > -1 ? fullName.slice(spaceIdx + 1) : '';
        localUser = await this.userRepository.upsertWithTenants(
          keycloakUserId!,
          email,
          {
            firstName,
            lastName,
            provider: AuthProvidersEnum.email,
            platformRole: { id: PlatformRoleEnum.USER } as any,
            status: { id: StatusEnum.active } as any,
            keycloakId: keycloakUserId!,
          },
          [{ tenantId: tenant!.id, roles: ['OWNER'], joinedAt: new Date() }],
        );
        stepLog(7, `User upserted in MongoDB: ${localUser.id}`);
      } catch (e) {
        stepErr(7, e);
        throw e;
      }

      // ── Step 8: Set owner on the Tenant ──────────────────────────────────────
      try {
        await this.tenantsRepository.updateOwner(
          tenant!.id,
          localUser.id as string,
        );
        stepLog(8, `Tenant owner set to ${localUser.id}`);
      } catch (e) {
        stepErr(8, e);
        throw e;
      }

      // ── Step 9: Confirm alias reservation ────────────────────────────────────
      try {
        await this.aliasReservationRepository.confirm(alias);
        stepLog(9, `Alias "${alias}" confirmed`);
      } catch (e) {
        stepErr(9, e);
        throw e;
      }

      // ── Emit event ────────────────────────────────────────────────────────────
      this.eventEmitter.emit(
        'tenant.created',
        new TenantCreatedEvent(tenant!.id, organizationName, email),
      );

      return {
        tenantId: tenant!.id,
        alias,
        organizationName,
        keycloakOrgId: keycloakOrgId!,
        loginUrl: this.getTenantLoginUrl(alias),
      };
    } catch (error: unknown) {
      // ── Saga Rollback (compensating transactions) ──────────────────────────────
      this.logger.error(
        '[Saga] Onboarding failed — rolling back compensating actions',
        error instanceof Error ? error.stack : String(error),
      );

      // Rollback Keycloak Org
      if (keycloakOrgId) {
        await this.keycloakAdminService
          .deleteOrganization(keycloakOrgId)
          .catch((e: unknown) =>
            this.logger.error(
              `[Saga][Rollback] Cannot delete Keycloak org ${keycloakOrgId}`,
              e instanceof Error ? e.message : e,
            ),
          );
      }

      // Rollback Keycloak User ONLY if we created it in this saga run.
      // Never delete a pre-existing user that merely joined a new org.
      if (keycloakUserCreatedByThisSaga && keycloakUserId) {
        await this.keycloakAdminService
          .deleteUser(keycloakUserId)
          .catch((e: unknown) =>
            this.logger.error(
              `[Saga][Rollback] Cannot delete Keycloak user ${keycloakUserId}`,
              e instanceof Error ? e.message : e,
            ),
          );
      }

      // Rollback alias reservation so the alias can be retried
      if (aliasReserved) {
        await this.aliasReservationRepository
          .delete(alias)
          .catch((e: unknown) =>
            this.logger.error(
              `[Saga][Rollback] Cannot delete alias reservation for "${alias}"`,
              e instanceof Error ? e.message : e,
            ),
          );
      }

      // Re-raise ConflictException as-is; wrap everything else
      if (error instanceof ConflictException) {
        throw error;
      }

      throw new InternalServerErrorException(
        'Tenant registration failed. All partial changes have been rolled back.',
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Saga: POST /api/auth/onboard-existing-user
  // ─────────────────────────────────────────────────────────────────────────────

  async onboardExistingUser(
    user: User,
    dto: OnboardExistingUserDto,
  ): Promise<RegisterTenantResult> {
    const { organizationName, organizationAlias: alias } = dto;
    const { email, keycloakId: keycloakUserId, firstName, lastName } = user;

    if (!keycloakUserId) {
      throw new InternalServerErrorException('User is missing Keycloak ID');
    }

    // ── Saga compensation trackers ─────────────────────────────────────────────
    let aliasReserved = false;
    let keycloakOrgId: string | null = null;

    const stepLog = (step: number, msg: string) =>
      this.logger.log(`[Saga-Onboard][Step ${step}] ${msg}`);
    const stepErr = (step: number, err: unknown) =>
      this.logger.error(
        `[Saga-Onboard][Step ${step} FAILED] ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );

    try {
      // ── Step 1: Atomic alias reservation ──────────────────────────────────────
      try {
        await this.aliasReservationRepository.reserve(alias);
        aliasReserved = true;
        stepLog(1, `Alias "${alias}" reserved`);
      } catch (e) {
        stepErr(1, e);
        throw e;
      }

      // ── Step 2: Create Keycloak Organization ──────────────────────────────────
      try {
        const kcOrg = await this.keycloakAdminService.createOrganization(
          organizationName,
          alias,
        );
        keycloakOrgId = kcOrg.id;
        stepLog(2, `KC org created: ${keycloakOrgId}`);
      } catch (e) {
        stepErr(2, e);
        throw e;
      }

      // ── Step 3: Add user to the organization ──────────────────────────────────
      try {
        await this.keycloakAdminService.addUserToOrganization(
          keycloakOrgId!,
          keycloakUserId as string,
        );
        stepLog(3, `User ${keycloakUserId} added to org ${keycloakOrgId}`);
      } catch (e) {
        stepErr(3, e);
        throw e;
      }

      // ── Step 4: Create Tenant record in MongoDB ───────────────────────────────
      let tenant: Tenant;
      try {
        const tenantData: Partial<Tenant> = {
          keycloakOrgId: keycloakOrgId!,
          alias,
          name: organizationName,
          ownerId: null as any,
          subscriptionPlan: SubscriptionPlan.FREE,
          status: TenantStatus.ACTIVE,
        };
        tenant = await this.tenantsRepository.create(tenantData);
        stepLog(4, `Tenant created in MongoDB: ${tenant.id}`);
      } catch (e) {
        stepErr(4, e);
        throw e;
      }

      // ── Step 5: Upsert User in MongoDB & add OWNER membership ─────────────────
      let localUser: any;
      try {
        localUser = await this.userRepository.upsertWithTenants(
          keycloakUserId as string,
          email || '',
          {
            firstName,
            lastName,
            provider: user.provider || AuthProvidersEnum.email,
            platformRole: user.platformRole as any,
            status: user.status as any,
            keycloakId: keycloakUserId as string,
          },
          [
            {
              tenantId: tenant!.id as string,
              roles: ['OWNER'],
              joinedAt: new Date(),
            },
          ],
        );
        stepLog(5, `User upserted in MongoDB: ${localUser.id}`);
      } catch (e) {
        stepErr(5, e);
        throw e;
      }

      // ── Step 6: Set owner on the Tenant ──────────────────────────────────────
      try {
        await this.tenantsRepository.updateOwner(
          tenant!.id as string,
          localUser.id as string,
        );
        stepLog(6, `Tenant owner set to ${localUser.id}`);
      } catch (e) {
        stepErr(6, e);
        throw e;
      }

      // ── Step 7: Confirm alias reservation ────────────────────────────────────
      try {
        await this.aliasReservationRepository.confirm(alias);
        stepLog(7, `Alias "${alias}" confirmed`);
      } catch (e) {
        stepErr(7, e);
        throw e;
      }

      // ── Emit event ────────────────────────────────────────────────────────────
      this.eventEmitter.emit(
        'tenant.created',
        new TenantCreatedEvent(
          tenant!.id as string,
          organizationName,
          email || '',
        ),
      );

      return {
        tenantId: tenant!.id as string,
        alias,
        organizationName,
        keycloakOrgId: keycloakOrgId!,
        loginUrl: this.getTenantLoginUrl(alias),
      };
    } catch (error: unknown) {
      // ── Saga Rollback (compensating transactions) ──────────────────────────────
      this.logger.error(
        '[Saga-Onboard] Onboarding failed — rolling back compensating actions',
        error instanceof Error ? error.stack : String(error),
      );

      if (keycloakOrgId) {
        await this.keycloakAdminService
          .deleteOrganization(keycloakOrgId)
          .catch((e: unknown) =>
            this.logger.error(
              `[Saga-Onboard][Rollback] Cannot delete Keycloak org ${keycloakOrgId}`,
              e instanceof Error ? e.message : e,
            ),
          );
      }

      if (aliasReserved) {
        await this.aliasReservationRepository
          .delete(alias)
          .catch((e: unknown) =>
            this.logger.error(
              `[Saga-Onboard][Rollback] Cannot delete alias reservation for "${alias}"`,
              e instanceof Error ? e.message : e,
            ),
          );
      }

      if (error instanceof ConflictException) {
        throw error;
      }

      throw new InternalServerErrorException(
        'Tenant onboarding failed. All partial changes have been rolled back.',
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Read operations
  // ─────────────────────────────────────────────────────────────────────────────

  async findById(id: string): Promise<Tenant | null> {
    return this.tenantsRepository.findById(id);
  }

  async findByAlias(alias: string): Promise<Tenant | null> {
    return this.tenantsRepository.findByAlias(alias);
  }

  async findByIds(ids: string[]): Promise<Tenant[]> {
    return this.tenantsRepository.findByIds(ids);
  }

  async updateOmniSettings(
    tenantId: string,
    omniSettings: { resolveNoteMode: 'disabled' | 'optional' | 'required' },
  ): Promise<Tenant | null> {
    return this.tenantsRepository.updateOmniSettings(tenantId, omniSettings);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Storage Quota Management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check whether a tenant is within their storage quota.
   * Returns { allowed, usedBytes, limitBytes, usagePercent }.
   * A limitBytes of -1 means unlimited.
   */
  async checkStorageQuota(tenantId: string): Promise<{
    allowed: boolean;
    usedBytes: number;
    limitBytes: number;
    usagePercent: number;
  }> {
    const tenant = await this.tenantsRepository.findById(tenantId);
    const quota = tenant?.storageQuota ?? {
      limitBytes: 1073741824,
      usedBytes: 0,
      warnThresholdPercent: 80,
    };

    if (quota.limitBytes === -1) {
      return {
        allowed: true,
        usedBytes: quota.usedBytes,
        limitBytes: -1,
        usagePercent: 0,
      };
    }

    const usagePercent =
      quota.limitBytes > 0
        ? Math.round((quota.usedBytes / quota.limitBytes) * 100)
        : 0;

    return {
      allowed: quota.usedBytes < quota.limitBytes,
      usedBytes: quota.usedBytes,
      limitBytes: quota.limitBytes,
      usagePercent,
    };
  }

  /**
   * Atomically increment the tenant's storage usage with quota guard.
   * Returns true if within quota and increment succeeded, false if over quota.
   */
  async incrementStorageUsage(
    tenantId: string,
    sizeInBytes: number,
  ): Promise<boolean> {
    return this.tenantsRepository.atomicIncrementStorage(tenantId, sizeInBytes);
  }

  /**
   * Atomically decrement the tenant's storage usage (hard-delete / rollback).
   */
  async decrementStorageUsage(
    tenantId: string,
    sizeInBytes: number,
  ): Promise<void> {
    await this.tenantsRepository.atomicDecrementStorage(tenantId, sizeInBytes);
  }

  /**
   * Update the tenant's storage limit (SUPER_ADMIN operation).
   */
  async updateStorageQuota(
    tenantId: string,
    limitBytes: number,
    warnThresholdPercent?: number,
  ): Promise<Tenant | null> {
    return this.tenantsRepository.updateStorageQuota(
      tenantId,
      limitBytes,
      warnThresholdPercent,
    );
  }

  /**
   * Get cached storage breakdown for a tenant.
   */
  async getStorageBreakdown(tenantId: string) {
    const tenant = await this.tenantsRepository.findById(tenantId);
    return {
      quota: tenant?.storageQuota ?? {
        limitBytes: 1073741824,
        usedBytes: 0,
        warnThresholdPercent: 80,
      },
      breakdown: tenant?.storageBreakdown ?? null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // i18n Settings
  // ─────────────────────────────────────────────────────────────────────────────

  private static readonly I18N_DEFAULTS = {
    locale: 'en',
    timezone: 'UTC',
    dateFormat: 'MM/DD/YYYY',
    currency: 'USD',
  };

  /**
   * Get the tenant's i18n settings, falling back to system defaults.
   */
  async getI18nSettings(tenantId: string): Promise<{
    locale: string;
    timezone: string;
    dateFormat: string;
    currency: string;
  }> {
    if (!tenantId) {
      throw new UnprocessableEntityException('Tenant context missing');
    }
    const tenant = await this.tenantsRepository.findById(tenantId);
    return tenant?.i18nSettings ?? { ...TenantsService.I18N_DEFAULTS };
  }

  /**
   * Partially update the tenant's i18n settings.
   */
  async updateI18nSettings(
    tenantId: string,
    settings: Partial<{
      locale: string;
      timezone: string;
      dateFormat: string;
      currency: string;
    }>,
  ): Promise<{
    locale: string;
    timezone: string;
    dateFormat: string;
    currency: string;
  }> {
    const updated = await this.tenantsRepository.updateI18nSettings(
      tenantId,
      settings,
    );
    return updated?.i18nSettings ?? { ...TenantsService.I18N_DEFAULTS };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tenant Profile
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get the tenant profile (name, alias, logoUrl).
   */
  async getProfile(tenantId: string) {
    if (!tenantId) {
      throw new UnprocessableEntityException('Tenant context missing');
    }
    const tenant = await this.tenantsRepository.findById(tenantId);
    return {
      tenantName: tenant?.name ?? '',
      logoUrl: tenant?.logoUrl ?? '',
      alias: tenant?.alias ?? '',
    };
  }

  /**
   * Partially update the tenant profile.
   */
  async updateProfile(
    tenantId: string,
    profile: { tenantName?: string; logoUrl?: string },
  ) {
    const payload: Partial<{ name: string; logoUrl: string }> = {};
    if (profile.tenantName !== undefined) payload.name = profile.tenantName;
    if (profile.logoUrl !== undefined) payload.logoUrl = profile.logoUrl;

    if (Object.keys(payload).length === 0) {
      return this.getProfile(tenantId);
    }

    await this.tenantsRepository.update(tenantId, payload);
    return this.getProfile(tenantId);
  }
}
