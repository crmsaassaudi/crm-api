import { ApiProperty, PartialType } from '@nestjs/swagger';
import {
  IsHexColor,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

export class CreateAccountStatusDto {
  @ApiProperty({ example: 'Active' })
  @IsString()
  @Length(1, 80)
  name: string;

  @ApiProperty({ example: 'active', required: false })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  apiName?: string;

  @ApiProperty({ example: '#10B981', required: false })
  @IsOptional()
  @IsHexColor()
  color?: string;

  @ApiProperty({ example: 10, required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  sortOrder?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;
}

export class UpdateAccountStatusDto extends PartialType(
  CreateAccountStatusDto,
) {}
