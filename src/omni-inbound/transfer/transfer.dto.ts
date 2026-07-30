import {
  IsBoolean,
  IsEnum,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateTransferDto {
  @IsEnum(['cold', 'warm', 'consult'])
  type: 'cold' | 'warm' | 'consult';

  @IsMongoId()
  targetAgentId: string;

  @IsMongoId()
  @IsOptional()
  targetGroupId?: string;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  reason?: string;

  @IsString()
  @MaxLength(4_000)
  @IsOptional()
  handoffNote?: string;
}

export class RejectTransferDto {
  @IsString()
  @MaxLength(500)
  @IsOptional()
  reason?: string;
}

export class CompleteTransferDto {
  @IsBoolean()
  @IsOptional()
  transferOwnership?: boolean;
}
