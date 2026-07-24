import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsMongoId,
  IsOptional,
  IsString,
  IsDateString,
  MaxLength,
} from 'class-validator';

export class GrantRoleAssignmentDto {
  @ApiProperty({ enum: ['user', 'group'] })
  @IsEnum(['user', 'group'])
  principalType: 'user' | 'group';

  @ApiProperty({ example: '507f1f77bcf86cd799439012' })
  @IsMongoId()
  principalId: string;

  @ApiProperty({ example: '507f1f77bcf86cd799439099' })
  @IsMongoId()
  roleId: string;

  @ApiPropertyOptional({
    description:
      'ISO timestamp when the grant lapses (JIT). Omit for a permanent grant.',
    example: '2026-08-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional({ example: 'On-call escalation for incident #4821' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
