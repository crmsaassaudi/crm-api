import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Request,
} from '@nestjs/common';
import { TenantsService, RegisterTenantResult } from './tenants.service';
import { RegisterTenantDto } from './dto/register-tenant.dto';
import { OnboardExistingUserDto } from './dto/onboard-existing-user.dto';
import {
  ApiTags,
  ApiOperation,
  ApiCreatedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { User } from '../users/domain/user';

@ApiTags('Auth')
@Controller({
  path: 'auth',
  version: '1',
})
export class TenantsAuthController {
  constructor(private readonly tenantsService: TenantsService) {}

  /**
   * POST /api/v1/auth/register
   *
   * Creates a new tenant (Organization) in Keycloak + MongoDB with full Saga rollback.
   * The organization alias becomes the canonical subdomain: https://{alias}.crm.com
   */
  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register a new tenant (SaaS onboarding)',
    description:
      'Atomically creates a Keycloak Organization, a user with org-admin role, and the corresponding MongoDB tenant/user documents. ' +
      'Fails fast with 409 if the organizationAlias is already taken.',
  })
  @ApiCreatedResponse({
    description: 'Tenant registered successfully',
    schema: {
      example: {
        tenantId: '507f1f77bcf86cd799439011',
        alias: 'toancorp',
        organizationName: 'Toan Corp',
        keycloakOrgId: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
        loginUrl: 'https://toancorp.crm.com/login',
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid payload' })
  @ApiConflictResponse({ description: 'organizationAlias is already taken' })
  async register(
    @Body() dto: RegisterTenantDto,
  ): Promise<RegisterTenantResult> {
    return this.tenantsService.register(dto);
  }

  /**
   * POST /api/v1/auth/onboard-existing-user
   *
   * Creates a new tenant (Organization) and binds it to the already authenticated user.
   */
  @ApiBearerAuth()
  @Post('onboard-existing-user')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Onboard an existing authenticated user by creating a new tenant for them',
  })
  @ApiCreatedResponse({ description: 'Tenant registered successfully' })
  @ApiBadRequestResponse({ description: 'Invalid payload' })
  @ApiConflictResponse({ description: 'organizationAlias is already taken' })
  async onboardExistingUser(
    @Request() request,
    @Body() dto: OnboardExistingUserDto,
  ): Promise<RegisterTenantResult> {
    const user = request.user as User;
    return this.tenantsService.onboardExistingUser(user, dto);
  }
}
