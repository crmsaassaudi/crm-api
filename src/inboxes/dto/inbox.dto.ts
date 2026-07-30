import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsMongoId,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateInboxDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsString()
  @Matches(/^[a-z0-9][a-z0-9_-]{1,63}$/)
  key: string;

  @IsEnum(['open', 'restricted'])
  @IsOptional()
  visibilityMode?: 'open' | 'restricted';

  @IsArray()
  @ArrayMaxSize(200)
  @IsMongoId({ each: true })
  @IsOptional()
  groupIds?: string[];

  @IsArray()
  @ArrayMaxSize(500)
  @IsMongoId({ each: true })
  @IsOptional()
  userIds?: string[];

  @IsMongoId()
  @IsOptional()
  routingRuleId?: string;

  @IsMongoId()
  @IsOptional()
  slaPolicyId?: string;

  @IsString()
  @IsOptional()
  botPolicyId?: string;

  @IsString()
  @IsOptional()
  businessHoursId?: string;

  @IsObject()
  @IsOptional()
  capacityPolicy?: {
    version?: number;
    capacityWeights?: Record<string, number>;
    afterContactWorkSeconds?: Record<string, number>;
  };
}

export class UpdateInboxDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @IsOptional()
  name?: string;

  @IsEnum(['active', 'archived'])
  @IsOptional()
  status?: 'active' | 'archived';

  @IsEnum(['open', 'restricted'])
  @IsOptional()
  visibilityMode?: 'open' | 'restricted';

  @IsArray()
  @ArrayMaxSize(200)
  @IsMongoId({ each: true })
  @IsOptional()
  groupIds?: string[];

  @IsArray()
  @ArrayMaxSize(500)
  @IsMongoId({ each: true })
  @IsOptional()
  userIds?: string[];

  @IsMongoId()
  @IsOptional()
  routingRuleId?: string | null;

  @IsMongoId()
  @IsOptional()
  slaPolicyId?: string | null;

  @IsString()
  @IsOptional()
  botPolicyId?: string | null;

  @IsString()
  @IsOptional()
  businessHoursId?: string | null;

  @IsObject()
  @IsOptional()
  capacityPolicy?: {
    version?: number;
    capacityWeights?: Record<string, number>;
    afterContactWorkSeconds?: Record<string, number>;
  } | null;
}
