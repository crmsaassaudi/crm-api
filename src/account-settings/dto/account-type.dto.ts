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

export class CreateAccountTypeDto {
  @ApiProperty({ example: 'Customer' })
  @IsString()
  @Length(1, 80)
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  apiName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsHexColor()
  color?: string;

  @ApiProperty({ required: false })
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

export class UpdateAccountTypeDto extends PartialType(CreateAccountTypeDto) {}
