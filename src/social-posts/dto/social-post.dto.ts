import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PartialType } from '@nestjs/swagger';
import {
  SOCIAL_POST_MEDIA_TYPES,
  SOCIAL_POST_STATUSES,
  SOCIAL_POST_TASK_STATUSES,
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

}

export class UpdateSocialPostDto extends PartialType(CreateSocialPostDto) {}

export class PublishSocialPostDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  channelIds: string[];

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
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

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
