import {
  Controller,
  Post,
  Delete,
  Get,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  UseGuards,
  Headers,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiAcceptedResponse,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiSecurity,
} from '@nestjs/swagger';
import { Unprotected } from 'nest-keycloak-connect';
import { ulid } from 'ulid';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InternalApiKeyGuard } from '../../common/guards/internal-api-key.guard';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import {
  CORE_PERMISSIONS,
  FEATURE_PERMISSIONS,
} from '../../common/permissions/permission.constants';
import { AuthzPermissionCacheService } from '../../common/permissions/authz-permission-cache.service';

import {
  InternalProvisionDto,
  InternalInviteDto,
} from '../dto/internal-provision.dto';
import { TenantProvisioningProducer } from '../workers/tenant-provisioning.producer';
import { OnboardingService } from '../services/onboarding.service';
import { ProvisioningJobRepository } from '../infrastructure/persistence/document/repositories/provisioning-job.repository';
import { KeycloakAdminService } from '../../auth/services/keycloak-admin.service';
import { UserRepository } from '../../users/infrastructure/persistence/user.repository';
import { TenantsRepository } from '../infrastructure/persistence/document/repositories/tenant.repository';
import { TenantAliasReservationRepository } from '../infrastructure/persistence/document/repositories/tenant-alias-reservation.repository';
import { generateAlias, ensureUniqueAlias } from '../utils/alias-generator';
import { AuthProvidersEnum } from '../../auth/auth-providers.enum';
import { PlatformRoleEnum } from '../../roles/platform-role.enum';
import { StatusEnum } from '../../statuses/statuses.enum';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../../config/config.type';

/**
 * Internal APIs for the Sales-Led Growth (SLG) flow.
 *
 * These endpoints are meant to be called by internal tools / Sales CRM
 * and should be protected by API key or internal network policy.
 */
@ApiTags('Internal – Tenant Provisioning')
@ApiSecurity('x-internal-api-key')
@Controller({
  path: 'internal/tenants',
  version: '1',
})
@Unprotected()
@UseGuards(InternalApiKeyGuard)
export class InternalTenantsController {
  private readonly logger = new Logger(InternalTenantsController.name);

  constructor(
    private readonly provisioningProducer: TenantProvisioningProducer,
    private readonly onboardingService: OnboardingService,
    private readonly keycloakAdminService: KeycloakAdminService,
    private readonly userRepository: UserRepository,
    private readonly tenantsRepository: TenantsRepository,
    private readonly aliasReservationRepository: TenantAliasReservationRepository,
    private readonly provisioningJobRepository: ProvisioningJobRepository,
    private readonly configService: ConfigService<AllConfigType>,
    private readonly eventEmitter: EventEmitter2,
    private readonly authzPermissionCache: AuthzPermissionCacheService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /api/v1/internal/tenants/provision
  // Sales creates a tenant for a customer (no password required)
  // ─────────────────────────────────────────────────────────────────────────────

  @Post('provision')
  @Idempotent()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'SLG: Provision a new tenant for a customer',
    description:
      'Enqueues an async provisioning job. The admin user will be created ' +
      'in Keycloak without a password — use the /invite endpoint to trigger ' +
      'a password setup email. Pass X-Idempotency-Key to make duplicate ' +
      'submits safe; the same provisioningId is returned for repeated calls.',
  })
  @ApiAcceptedResponse({ description: 'Provisioning job queued' })
  @ApiBadRequestResponse({ description: 'Invalid payload' })
  async provision(
    @Body() dto: InternalProvisionDto,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    const { companyName, adminEmail, adminFullName, plan } = dto;

    // 1. Generate and reserve unique alias
    const baseAlias = generateAlias(companyName);
    const alias = await ensureUniqueAlias(
      baseAlias,
      this.aliasReservationRepository,
    );

    // 2. Generate provisioningId and persist to MongoDB first (DB-first pattern)
    const provisioningId = `prov_${ulid()}`;

    // DB write before Redis — MongoDB is the source of truth for history/audit
    await this.provisioningJobRepository.create({
      provisioningId,
      source: 'SLG',
      companyName,
      adminEmail,
      alias,
    });

    // Redis cache for fast polling (best-effort; DB remains authoritative)
    await this.onboardingService.setProvisioningQueued(provisioningId);

    await this.provisioningProducer.enqueue({
      provisioningId,
      userId: null, // SLG: user will be created by the worker
      email: adminEmail,
      fullName: adminFullName,
      companyName,
      alias,
      plan,
      source: 'SLG',
    });

    this.logger.log(
      `[SLG] Provisioning queued: ${provisioningId} for "${companyName}" (admin: ${adminEmail}) correlationId=${correlationId ?? '-'}`,
    );

    const apiPrefix =
      this.configService.get('app.apiPrefix', { infer: true }) ?? 'api';
    const apiVersion = '1';

    return {
      provisioningId,
      status: 'QUEUED',
      alias,
      pollingUrl: `/${apiPrefix}/v${apiVersion}/onboarding/status/${provisioningId}`,
      realtimeChannel: `provisioning:${provisioningId}`,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /api/v1/internal/tenants/:tenantId/invite
  // Send invite email using Keycloak Execute Actions Email
  // ─────────────────────────────────────────────────────────────────────────────

  @Post(':tenantId/invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'SLG: Invite a user to a tenant via Keycloak password setup email',
    description:
      'Creates the user in Keycloak (if needed), adds them to the tenant, ' +
      'and triggers Keycloak\'s "Execute Actions Email" with UPDATE_PASSWORD action.',
  })
  @ApiOkResponse({ description: 'Invitation email sent successfully' })
  @ApiBadRequestResponse({ description: 'Invalid payload' })
  @ApiNotFoundResponse({ description: 'Tenant not found' })
  async invite(
    @Param('tenantId') tenantId: string,
    @Body() dto: InternalInviteDto,
  ) {
    const { email, role } = dto;

    // 1. Verify tenant exists
    const tenant = await this.tenantsRepository.findById(tenantId);
    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    // 2. Find or create Keycloak user (no password)
    let kcUser = await this.keycloakAdminService.findUserByEmail(email);
    let kcUserId: string;

    if (kcUser) {
      kcUserId = kcUser.id;
      this.logger.log(`Reusing existing KC user ${kcUserId} for ${email}`);
    } else {
      // Create without a real password — user will set it via the action email
      const tempPassword = `Temp${ulid().slice(-12)}!`;
      kcUser = await this.keycloakAdminService.createUser(
        email,
        tempPassword,
        email.split('@')[0], // use email prefix as name placeholder
      );
      kcUserId = kcUser.id;
      this.logger.log(`Created KC user ${kcUserId} for invite`);
    }

    // 3. Add user to Keycloak organization
    if (tenant.keycloakOrgId) {
      await this.keycloakAdminService
        .addUserToOrganization(tenant.keycloakOrgId, kcUserId)
        .catch((e) => {
          // May fail if already a member — non-fatal
          this.logger.warn(
            `Could not add user to KC org (may already be member): ${e.message}`,
          );
        });
    }

    // 4. Upsert user in MongoDB with tenant membership
    await this.userRepository.upsertWithTenants(
      kcUserId,
      email,
      {
        firstName: kcUser.firstName || email.split('@')[0],
        lastName: kcUser.lastName || '',
        provider: AuthProvidersEnum.email,
        platformRole: { id: PlatformRoleEnum.USER } as any,
        status: { id: StatusEnum.active } as any,
        keycloakId: kcUserId,
      },
      [{ tenantId, roles: [role], joinedAt: new Date() }],
    );

    // 5. Trigger Keycloak Execute Actions Email (UPDATE_PASSWORD)
    //    Keycloak sends the email with a secure link to set password.
    const rootDomain =
      this.configService.get('app.rootDomain', { infer: true }) ||
      'crmsaudi.dev';
    const redirectUri = `https://${tenant.alias}.${rootDomain}/login`;

    await this.keycloakAdminService.executeActionsEmail(
      kcUserId,
      ['UPDATE_PASSWORD'],
      redirectUri,
    );

    this.logger.log(
      `[SLG] Invite sent to ${email} for tenant "${tenant.name}" (role: ${role})`,
    );

    return {
      message: 'Invitation email sent successfully',
      email,
      role,
      tenantAlias: tenant.alias,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /api/v1/internal/tenants/:tenantId/feature-permissions
  // Inspect what feature permissions are granted to a specific tenant
  // ─────────────────────────────────────────────────────────────────────────────

  @Get(':tenantId/feature-permissions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin: List feature permissions for a tenant',
    description:
      'Returns the Core baseline and any extra Feature permissions explicitly ' +
      'granted to this tenant.',
  })
  @ApiOkResponse()
  @ApiNotFoundResponse({ description: 'Tenant not found' })
  async getFeaturePermissions(@Param('tenantId') tenantId: string) {
    const tenant = await this.tenantsRepository.findById(tenantId);
    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    return {
      tenantId,
      tenantAlias: tenant.alias,
      corePermissions: CORE_PERMISSIONS,
      disabledCorePermissions: tenant.disabledCorePermissions ?? [],
      grantedFeaturePermissions: tenant.availablePermissions ?? [],
      availableFeaturePermissions: FEATURE_PERMISSIONS,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /api/v1/internal/tenants/:tenantId/feature-permissions/grant
  // Grant one or more feature permissions to a specific tenant
  // ─────────────────────────────────────────────────────────────────────────────

  @Post(':tenantId/feature-permissions/grant')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin: Grant feature permissions to a tenant',
    description:
      "Adds the given permission keys to the tenant's `availablePermissions` list. " +
      "The tenant's Owner gains access immediately on the next request. Idempotent.",
  })
  @ApiOkResponse()
  @ApiBadRequestResponse({ description: 'Invalid permission keys' })
  @ApiNotFoundResponse({ description: 'Tenant not found' })
  async grantFeaturePermissions(
    @Param('tenantId') tenantId: string,
    @Body() body: { permissions: string[] },
  ) {
    const tenant = await this.tenantsRepository.findById(tenantId);
    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    // Validate: only known FEATURE_PERMISSIONS can be granted via this endpoint
    const invalid = body.permissions.filter(
      (p) => !FEATURE_PERMISSIONS.includes(p),
    );
    if (invalid.length > 0) {
      throw new Error(
        `Unknown or non-feature permissions: ${invalid.join(', ')}. ` +
          `Only FEATURE_PERMISSIONS can be granted via this endpoint.`,
      );
    }

    const updated = await this.tenantsRepository.grantFeaturePermissions(
      tenantId,
      body.permissions,
    );
    await this.authzPermissionCache.invalidateTenant(tenantId);
    this.eventEmitter.emit('tenant.permissions.updated', { tenantId });

    this.logger.log(
      `[Admin] Granted [${body.permissions.join(', ')}] to tenant "${tenant.alias}"`,
    );

    return {
      tenantId,
      tenantAlias: tenant.alias,
      grantedFeaturePermissions: updated?.availablePermissions ?? [],
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DELETE /api/v1/internal/tenants/:tenantId/feature-permissions/revoke
  // Revoke one or more feature permissions from a specific tenant
  // ─────────────────────────────────────────────────────────────────────────────

  @Delete(':tenantId/feature-permissions/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin: Revoke feature permissions from a tenant',
    description:
      "Removes the given permission keys from the tenant's `availablePermissions` " +
      'list. Takes effect immediately on the next request. Idempotent.',
  })
  @ApiOkResponse()
  @ApiNotFoundResponse({ description: 'Tenant not found' })
  async revokeFeaturePermissions(
    @Param('tenantId') tenantId: string,
    @Body() body: { permissions: string[] },
  ) {
    const tenant = await this.tenantsRepository.findById(tenantId);
    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    const updated = await this.tenantsRepository.revokeFeaturePermissions(
      tenantId,
      body.permissions,
    );
    await this.authzPermissionCache.invalidateTenant(tenantId);
    this.eventEmitter.emit('tenant.permissions.updated', { tenantId });

    this.logger.log(
      `[Admin] Revoked [${body.permissions.join(', ')}] from tenant "${tenant.alias}"`,
    );

    return {
      tenantId,
      tenantAlias: tenant.alias,
      grantedFeaturePermissions: updated?.availablePermissions ?? [],
    };
  }
}
