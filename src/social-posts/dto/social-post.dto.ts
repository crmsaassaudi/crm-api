import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  SOCIAL_POST_APPROVAL_STATUSES,
  SOCIAL_POST_MEDIA_TYPES,
  SOCIAL_POST_STATUSES,
  SOCIAL_POST_TASK_STATUSES,
  SocialPostApprovalStatus,
  SocialPostMediaType,
  SocialPostStatus,
  SocialPostTaskStatus,
} from '../social-posts.types';

export class CreateSocialPostDto {
  @IsString()
  @MaxLength(63206)
  content: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  mediaUrls?: string[];

  @IsOptional()
  @IsEnum(SOCIAL_POST_MEDIA_TYPES)
  mediaType?: SocialPostMediaType;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  channelIds: string[];

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @IsOptional()
  @IsEnum(SOCIAL_POST_APPROVAL_STATUSES)
  approvalStatus?: SocialPostApprovalStatus;
}

export class UpdateSocialPostDto {
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
  @IsEnum(SOCIAL_POST_MEDIA_TYPES)
  mediaType?: SocialPostMediaType;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  channelIds?: string[];

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}

export class ScheduleSocialPostDto {
  @IsNotEmpty()
  @IsDateString()
  scheduledAt: string;
}

export class RejectSocialPostDto {
  @IsString()
  @MaxLength(1000)
  reason: string;
}

export class ListSocialPostsQueryDto {
  @IsOptional()
  page?: number;

  @IsOptional()
  limit?: number;

  @IsOptional()
  @IsEnum(SOCIAL_POST_STATUSES)
  status?: SocialPostStatus;

  @IsOptional()
  @IsEnum(SOCIAL_POST_APPROVAL_STATUSES)
  approvalStatus?: SocialPostApprovalStatus;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class ListSocialPostTasksQueryDto {
  @IsOptional()
  page?: number;

  @IsOptional()
  limit?: number;

  @IsOptional()
  @IsEnum(SOCIAL_POST_TASK_STATUSES)
  status?: SocialPostTaskStatus;

  @IsOptional()
  @IsString()
  platform?: string;
}
