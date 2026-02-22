import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { TenantsRepository } from './infrastructure/persistence/document/repositories/tenant.repository';
import { TenantAliasReservationRepository } from './infrastructure/persistence/document/repositories/tenant-alias-reservation.repository';
import { RegisterTenantDto } from './dto/register-tenant.dto';
import { Tenant, SubscriptionPlan, TenantStatus } from './domain/tenant';
import { KeycloakAdminService } from '../auth/services/keycloak-admin.service';
import { PlatformRoleEnum } from '../roles/platform-role.enum';
import { AuthProvidersEnum } from '../auth/auth-providers.enum';
import { StatusEnum } from '../statuses/statuses.enum';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantCreatedEvent } from './events/tenant-created.event';
import { UserRepository } from '../users/infrastructure/persistence/user.repository';

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
  ) {}

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
          owner: null as any,
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
          [{ tenant: tenant!.id, roles: ['OWNER'], joinedAt: new Date() }],
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
        loginUrl: `https://${alias}.crm.com/login`,
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
  // Read operations
  // ─────────────────────────────────────────────────────────────────────────────

  async findById(id: string): Promise<Tenant | null> {
    return this.tenantsRepository.findById(id);
  }

  async findByAlias(alias: string): Promise<Tenant | null> {
    return this.tenantsRepository.findByAlias(alias);
  }
}
