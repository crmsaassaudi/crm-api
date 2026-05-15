import {
  Controller,
  Post,
  Patch,
  Get,
  Body,
  Param,
  Request,
  Res,
  HttpCode,
  HttpStatus,
  ConflictException,
  NotFoundException,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../../config/config.type';
import {
  ApiTags,
  ApiOperation,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Unprotected } from 'nest-keycloak-connect';
import { v4 as uuidv4 } from 'uuid';

import { OnboardingStartDto } from '../dto/onboarding-start.dto';
import { OnboardingContextDto } from '../dto/onboarding-context.dto';
import { OnboardingService } from '../services/onboarding.service';
import { TenantProvisioningProducer } from '../workers/tenant-provisioning.producer';
import { KeycloakAdminService } from '../../auth/services/keycloak-admin.service';
import { UserRepository } from '../../users/infrastructure/persistence/user.repository';
import { SessionService } from '../../auth/services/session.service';
import { AuthProvidersEnum } from '../../auth/auth-providers.enum';
import { PlatformRoleEnum } from '../../roles/platform-role.enum';
import { StatusEnum } from '../../statuses/statuses.enum';
import { SubscriptionPlan } from '../domain/tenant';
import { generateAlias, ensureUniqueAlias } from '../utils/alias-generator';
import { TenantAliasReservationRepository } from '../infrastructure/persistence/document/repositories/tenant-alias-reservation.repository';
import {
  SID_COOKIE,
  clearSessionCookieVariants,
  getSessionCookieOptions,
} from '../../auth/session-cookie.util';

@ApiTags('Onboarding')
@Controller({
  path: 'onboarding',
  version: '1',
})
export class OnboardingController {
  private readonly logger = new Logger(OnboardingController.name);

  constructor(
    private readonly onboardingService: OnboardingService,
    private readonly provisioningProducer: TenantProvisioningProducer,
    private readonly keycloakAdminService: KeycloakAdminService,
    private readonly userRepository: UserRepository,
    private readonly sessionService: SessionService,
    private readonly aliasReservationRepository: TenantAliasReservationRepository,
    private readonly configService: ConfigService<AllConfigType>,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /api/v1/onboarding/start (Public)
  // Step 1: Create KC user + MongoDB user + session + onboarding Redis state
  // ─────────────────────────────────────────────────────────────────────────────

  @Unprotected()
  @Post('start')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Start PLG onboarding — create account with email' })
  @ApiCreatedResponse({ description: 'Account created, session started' })
  @ApiBadRequestResponse({ description: 'Invalid payload' })
  @ApiConflictResponse({ description: 'Email already registered' })
  async start(
    @Body() dto: OnboardingStartDto,
    @Request() req,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { email, fullName, password } = dto;
    let step = 'checking existing account';
    let createdKcUserId: string | null = null;

    try {
      // 1. Check if email already exists in MongoDB or Keycloak
      const [existingLocalUser, existingKcUser] = await Promise.all([
        this.userRepository.findByEmail(email),
        this.keycloakAdminService.findUserByEmail(email),
      ]);
      if (existingLocalUser || existingKcUser) {
        throw new ConflictException(
          'Email already registered. Please login instead.',
        );
      }

      // 2. Create Keycloak user (emailVerified=false for later banner)
      step = 'creating Keycloak user';
      const kcUser = await this.keycloakAdminService.createUser(
        email,
        password,
        fullName,
      );
      createdKcUserId = kcUser.id;

      // 3. Create MongoDB user with INCOMPLETE tag
      step = 'creating local user';
      const spaceIdx = fullName.indexOf(' ');
      const firstName = spaceIdx > -1 ? fullName.slice(0, spaceIdx) : fullName;
      const lastName = spaceIdx > -1 ? fullName.slice(spaceIdx + 1) : '';

      const localUser = await this.userRepository.create({
        email,
        firstName,
        lastName,
        keycloakId: kcUser.id,
        provider: AuthProvidersEnum.email,
        platformRole: { id: PlatformRoleEnum.USER } as any,
        status: { id: StatusEnum.active } as any,
        tenants: [],
        onboardingStatus: 'INCOMPLETE_ONBOARDING',
      } as any);

      // 4. Create session (lightweight — no full OAuth token exchange)
      step = 'creating session';
      const sid = await this.sessionService.createSession(
        {
          access_token: '',
          refresh_token: '',
          id_token: '',
          expires_in: 86400,
        },
        localUser.id as string,
      );

      // 5. Set onboarding session cookie using the same scope as auth cookies.
      clearSessionCookieVariants(res, this.configService, req.hostname);
      res.cookie(
        SID_COOKIE,
        sid,
        getSessionCookieOptions(this.configService, req.hostname),
      );

      // 6. Create onboarding session in Redis
      step = 'creating onboarding session';
      await this.onboardingService.createSession(localUser.id as string);

      this.logger.log(
        `PLG onboarding started for ${email} (userId=${localUser.id})`,
      );

      return {
        userId: localUser.id,
        nextStep: 2,
      };
    } catch (error: any) {
      if (createdKcUserId) {
        await this.keycloakAdminService
          .deleteUser(createdKcUserId)
          .catch((rollbackError) => {
            this.logger.error(
              `[OnboardingStart][Rollback] Failed to delete Keycloak user ${createdKcUserId}`,
              rollbackError?.stack || rollbackError,
            );
          });
      }

      this.logger.error(
        `[OnboardingStart] Failed while ${step} for ${email}: ${error?.message || error}`,
        error?.stack || error,
      );

      if (error instanceof HttpException) {
        throw error;
      }

      if (error?.code === 11000) {
        throw new ConflictException(
          'Email already registered. Please login instead.',
        );
      }

      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /api/v1/onboarding/context (Authenticated)
  // Hydrate frontend state on F5/refresh
  // ─────────────────────────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @Get('context')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get current onboarding session state (F5 resilience)',
  })
  @ApiOkResponse({ description: 'Onboarding session data' })
  @ApiNotFoundResponse({ description: 'No active onboarding session' })
  async getContext(@Request() req) {
    const userId = this.extractUserId(req);
    const session = await this.onboardingService.getSession(userId);
    if (!session) {
      throw new NotFoundException('No active onboarding session found');
    }
    return {
      step: session.step,
      data: {
        companyName: session.companyName || null,
        teamSize: session.teamSize || null,
        useCase: session.useCase || null,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PATCH /api/v1/onboarding/context (Authenticated)
  // Steps 2-3: Progressive profiling
  // ─────────────────────────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @Patch('context')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update onboarding context (progressive profiling)',
  })
  @ApiOkResponse({ description: 'Context updated' })
  @ApiNotFoundResponse({ description: 'No active onboarding session' })
  async updateContext(@Request() req, @Body() dto: OnboardingContextDto) {
    const userId = this.extractUserId(req);
    const session = await this.onboardingService.updateSession(userId, dto);
    return {
      step: session.step,
      data: {
        companyName: session.companyName || null,
        teamSize: session.teamSize || null,
        useCase: session.useCase || null,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /api/v1/onboarding/complete (Authenticated)
  // Queue the tenant provisioning job
  // ─────────────────────────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @Post('complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Complete onboarding — queue tenant provisioning' })
  @ApiAcceptedResponse({ description: 'Provisioning job queued' })
  @ApiNotFoundResponse({ description: 'No active onboarding session' })
  async complete(@Request() req) {
    const userId = this.extractUserId(req);
    const session = await this.onboardingService.getSession(userId);
    if (!session || !session.companyName) {
      throw new NotFoundException(
        'No active onboarding session or missing company name',
      );
    }

    // 1. Generate and reserve unique alias
    const baseAlias = generateAlias(session.companyName);
    const alias = await ensureUniqueAlias(
      baseAlias,
      this.aliasReservationRepository,
    );

    // 2. Look up user details for the job
    const user = (await this.userRepository.findByIdsGlobal([userId]))[0];
    if (!user) throw new NotFoundException('User not found');

    // 3. Enqueue provisioning job
    const provisioningId = `prov_${uuidv4().slice(0, 12)}`;

    await this.onboardingService.setProvisioningQueued(provisioningId);

    await this.provisioningProducer.enqueue({
      provisioningId,
      userId,
      email: user.email || '',
      fullName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      companyName: session.companyName,
      alias,
      plan: SubscriptionPlan.FREE,
      useCase: session.useCase,
      source: 'PLG',
    });

    // 4. Cleanup onboarding session
    await this.onboardingService.deleteSession(userId);

    this.logger.log(
      `PLG provisioning queued: ${provisioningId} for "${session.companyName}"`,
    );

    return {
      provisioningId,
      status: 'QUEUED',
      pollingUrl: `/api/v1/onboarding/status/${provisioningId}`,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /api/v1/onboarding/status/:provisioningId (Authenticated)
  // Frontend polls every 2s during loading screen
  // ─────────────────────────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @Get('status/:provisioningId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Poll provisioning status' })
  @ApiOkResponse({ description: 'Current provisioning status' })
  @ApiNotFoundResponse({ description: 'Provisioning ID not found' })
  async getStatus(
    @Param('provisioningId') provisioningId: string,
    @Request() req,
    @Res({ passthrough: true }) res: Response,
  ) {
    const status =
      await this.onboardingService.getProvisioningStatus(provisioningId);
    if (!status) {
      throw new NotFoundException('Provisioning ID not found');
    }
    if (status.status === 'READY') {
      clearSessionCookieVariants(res, this.configService, req.hostname);
    }
    return status;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private extractUserId(req: any): string {
    // From session-based auth or Keycloak JWT
    return req.user?.id || req.user?.sub || '';
  }
}
