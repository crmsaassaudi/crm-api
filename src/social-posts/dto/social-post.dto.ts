import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PartialType } from '@nestjs/swagger';
import {
  PUBLICATION_INSTANCE_STATUSES,
  SOCIAL_CONTENT_APPROVAL_STATUSES,
  SOCIAL_CONTENT_ASSET_STATUSES,
  SOCIAL_CONTENT_MEDIA_TYPES,
  PublicationInstanceStatus,
  SocialContentApprovalStatus,
  SocialContentAssetStatus,
  SocialContentMediaType,
} from '../social-posts.types';

export class CreateSocialContentAssetDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsString()
  @MaxLength(63206)
  content: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  mediaUrls?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1)
  @IsString({ each: true })
  aiVideoJobIds?: string[];

  @IsOptional()
  @IsEnum(SOCIAL_CONTENT_MEDIA_TYPES)
  mediaType?: SocialContentMediaType;
}

export class UpdateSocialContentAssetDto extends PartialType(
  CreateSocialContentAssetDto,
) {
  @IsOptional()
  @IsString()
  changeNote?: string;
}

export class PublicationChannelOverrideDto {
  @IsString()
  channelId: string;

  @IsOptional()
  @IsString()
  @MaxLength(63206)
  content?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  mediaUrls?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1)
  @IsString({ each: true })
  aiVideoJobIds?: string[];

  @IsOptional()
  @IsEnum(SOCIAL_CONTENT_MEDIA_TYPES)
  mediaType?: SocialContentMediaType;
}

export class CreatePublicationInstancesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  channelIds: string[];

  @IsOptional()
  @IsString()
  versionId?: string;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PublicationChannelOverrideDto)
  overrides?: PublicationChannelOverrideDto[];
}

export class UpdatePublicationInstanceDto {
  @IsOptional()
  @IsString()
  @MaxLength(63206)
  content?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  mediaUrls?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1)
  @IsString({ each: true })
  aiVideoJobIds?: string[];

  @IsOptional()
  @IsEnum(SOCIAL_CONTENT_MEDIA_TYPES)
  mediaType?: SocialContentMediaType;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}

export class RejectSocialContentAssetVersionDto {
  @IsString()
  @MaxLength(1000)
  reason: string;
}

export class ListSocialContentAssetsQueryDto {
  @IsOptional()
  page?: number;

  @IsOptional()
  limit?: number;

  @IsOptional()
  @IsEnum(SOCIAL_CONTENT_ASSET_STATUSES)
  status?: SocialContentAssetStatus;

  @IsOptional()
  @IsEnum(SOCIAL_CONTENT_APPROVAL_STATUSES)
  approvalStatus?: SocialContentApprovalStatus;
}

export class ListPublicationInstancesQueryDto {
  @IsOptional()
  page?: number;

  @IsOptional()
  limit?: number;

  @IsOptional()
  @IsEnum(PUBLICATION_INSTANCE_STATUSES)
  status?: PublicationInstanceStatus;

  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @IsString()
  assetId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
