import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';
import { SubscriptionPlan } from '../domain/tenant';

/**
 * POST /api/v1/internal/tenants/provision
 * SLG Flow: Sales creates a tenant for a customer.
 */
export class InternalProvisionDto {
  @ApiProperty({ example: 'Tech Startup VN' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  companyName: string;

  @ApiProperty({ example: 'admin@techstartup.vn' })
  @IsEmail()
  @IsNotEmpty()
  adminEmail: string;

  @ApiProperty({ example: 'Nguyen Van A' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  adminFullName: string;

  @ApiProperty({ example: 'PRO', enum: SubscriptionPlan })
  @IsEnum(SubscriptionPlan)
  plan: SubscriptionPlan;
}

/**
 * POST /api/v1/internal/tenants/:tenantId/invite
 * SLG Flow: Send invite to set up password via Keycloak.
 */
export class InternalInviteDto {
  @ApiProperty({ example: 'user@company.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'ADMIN', enum: ['OWNER', 'ADMIN', 'MEMBER'] })
  @IsString()
  @IsNotEmpty()
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}
