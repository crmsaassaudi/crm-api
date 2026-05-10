import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsEnum, MaxLength } from 'class-validator';

export enum TeamSizeEnum {
  SOLO = '1-10',
  SMALL = '11-50',
  MEDIUM = '51-200',
  LARGE = '200+',
}

export enum UseCaseEnum {
  SALES_PIPELINE = 'sales_pipeline',
  CUSTOMER_SUPPORT = 'customer_support',
  MARKETING = 'marketing',
  ALL = 'all',
}

/**
 * PATCH /api/v1/onboarding/context
 * Steps 2-3: Progressive profiling — company info & use case.
 */
export class OnboardingContextDto {
  @ApiPropertyOptional({ example: 'Acme Corporation' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  companyName?: string;

  @ApiPropertyOptional({ enum: TeamSizeEnum, example: '11-50' })
  @IsOptional()
  @IsEnum(TeamSizeEnum)
  teamSize?: TeamSizeEnum;

  @ApiPropertyOptional({ enum: UseCaseEnum, example: 'sales_pipeline' })
  @IsOptional()
  @IsEnum(UseCaseEnum)
  useCase?: UseCaseEnum;
}
