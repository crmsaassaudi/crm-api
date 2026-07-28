import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsMongoId,
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

  @ApiProperty({
    description:
      'ISO timestamp when the grant lapses (JIT). Omit for a permanent grant.',
    example: '2026-08-01T00:00:00.000Z',
  })
  @IsDateString()
  expiresAt: string;

  @ApiProperty({ example: 'On-call escalation for incident #4821' })
  @IsString()
  @MaxLength(500)
  reason: string;
}
