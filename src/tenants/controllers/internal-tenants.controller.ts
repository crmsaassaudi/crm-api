import {
  Controller,
  Post,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiAcceptedResponse,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { Unprotected } from 'nest-keycloak-connect';
import { v4 as uuidv4 } from 'uuid';

import {
  InternalProvisionDto,
  InternalInviteDto,
} from '../dto/internal-provision.dto';
import { TenantProvisioningProducer } from '../workers/tenant-provisioning.producer';
import { OnboardingService } from '../services/onboarding.service';
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
@Controller({
  path: 'internal/tenants',
  version: '1',
})
@Unprotected() // TODO: Replace with API key guard for production
export class InternalTenantsController {
  private readonly logger = new Logger(InternalTenantsController.name);

  constructor(
    private readonly provisioningProducer: TenantProvisioningProducer,
    private readonly onboardingService: OnboardingService,
    private readonly keycloakAdminService: KeycloakAdminService,
    private readonly userRepository: UserRepository,
    private readonly tenantsRepository: TenantsRepository,
    private readonly aliasReservationRepository: TenantAliasReservationRepository,
    private readonly configService: ConfigService<AllConfigType>,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /api/v1/internal/tenants/provision
  // Sales creates a tenant for a customer (no password required)
  // ─────────────────────────────────────────────────────────────────────────────

  @Post('provision')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'SLG: Provision a new tenant for a customer',
    description:
      'Enqueues an async provisioning job. The admin user will be created ' +
      'in Keycloak without a password — use the /invite endpoint to trigger ' +
      'a password setup email.',
  })
  @ApiAcceptedResponse({ description: 'Provisioning job queued' })
  @ApiBadRequestResponse({ description: 'Invalid payload' })
  async provision(@Body() dto: InternalProvisionDto) {
    const { companyName, adminEmail, adminFullName, plan } = dto;

    // 1. Generate and reserve unique alias
    const baseAlias = generateAlias(companyName);
    const alias = await ensureUniqueAlias(
      baseAlias,
      this.aliasReservationRepository,
    );

    // 2. Enqueue provisioning job
    const provisioningId = `prov_${uuidv4().slice(0, 12)}`;

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
      `[SLG] Provisioning queued: ${provisioningId} for "${companyName}" (admin: ${adminEmail})`,
    );

    return {
      provisioningId,
      status: 'QUEUED',
      alias,
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
      const tempPassword = `Temp${uuidv4().slice(0, 12)}!`;
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
}
