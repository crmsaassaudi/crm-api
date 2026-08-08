import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { AudienceDefinitionDto } from '../../contacts/audience/dto/audience-definition.dto';
import { CAMPAIGN_CHANNELS, CampaignChannel } from '../domain/campaign-channel';
import { CAMPAIGN_STATUSES, CampaignStatus } from '../campaign.schema';
import {
  RECIPIENT_STATUSES,
  RecipientStatus,
} from '../campaign-recipient.schema';

export class QuietHoursDto {
  @ApiProperty({ example: '21:00' })
  @IsString()
  start: string;

  @ApiProperty({ example: '08:00' })
  @IsString()
  end: string;
}

export class CampaignScheduleDto {
  /** Absent means "send as soon as it is launched". */
  @ApiPropertyOptional({ example: '2026-08-10T09:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  sendAt?: string;

  @ApiPropertyOptional({ example: 'Asia/Riyadh', default: 'UTC' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  timezone?: string;

  @ApiPropertyOptional({ type: QuietHoursDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => QuietHoursDto)
  quietHours?: QuietHoursDto;
}

export class CreateCampaignDto {
  @ApiProperty({ example: 'Eid promotion — Riyadh VIPs' })
  @IsString()
  @Length(3, 160)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @ApiPropertyOptional({ example: 'Reactivate customers quiet for 90 days' })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  objective?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ enum: CAMPAIGN_CHANNELS as unknown as string[] })
  @IsIn(CAMPAIGN_CHANNELS as unknown as string[])
  channelType: CampaignChannel;

  /**
   * Sender and content, shaped by `channelType`.
   *
   * Only "is an object" is checked here. The per-channel rules live in
   * `assertChannelConfig`, which the service calls on save and the worker calls
   * again before the first send — one implementation, so a DTO cannot drift from
   * what the sender actually requires.
   */
  @ApiProperty({
    description: 'Channel-specific configuration; see assertChannelConfig.',
    example: {
      type: 'email',
      configId: '665f1c...',
      subject: 'Eid Mubarak, {{firstName}}',
      htmlBody: '<p>…</p>',
    },
  })
  @IsObject()
  channelConfig: Record<string, unknown>;

  /**
   * Who to send to.
   *
   * Saved segments and inline conditions are the same thing here — an
   * `AudienceSource` — so a marketer can define an audience without first
   * leaving to create a segment, and can still reuse one when it exists. Both
   * compile through the contact filter compiler, so there is no second set of
   * operators to keep in step.
   */
  @ApiProperty({ type: AudienceDefinitionDto })
  @IsObject()
  @ValidateNested()
  @Type(() => AudienceDefinitionDto)
  audience: AudienceDefinitionDto;

  @ApiPropertyOptional({ type: CampaignScheduleDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CampaignScheduleDto)
  schedule?: CampaignScheduleDto;

  @ApiPropertyOptional({ example: 5000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  budget?: number;

  @ApiPropertyOptional({ example: 'SAR' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  ownerId?: string;
}

/**
 * Every field optional — but `status` is absent on purpose.
 *
 * Status changes go through the lifecycle endpoints (`/launch`, `/pause`,
 * `/resume`, `/cancel`), which enforce the legal transitions. A PATCH that could
 * set `status: 'sending'` would be a way to start a campaign while skipping
 * every one of those checks.
 */
export class UpdateCampaignDto extends PartialType(CreateCampaignDto) {}

export class ListCampaignsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  @Type(() => Number)
  limit?: number;

  @ApiPropertyOptional({ description: 'Matches campaign name or code.' })
  @IsOptional()
  @IsString()
  @Length(0, 160)
  search?: string;

  /** The list view's `[{ id, value }]` array, JSON-encoded. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  filters?: string;

  @ApiPropertyOptional({
    enum: ['name', 'code', 'status', 'createdAt', 'updatedAt', 'budget'],
  })
  @IsOptional()
  @IsIn(['name', 'code', 'status', 'createdAt', 'updatedAt', 'budget'])
  sortBy?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @ApiPropertyOptional({ enum: CAMPAIGN_STATUSES as unknown as string[] })
  @IsOptional()
  @IsIn(CAMPAIGN_STATUSES as unknown as string[])
  status?: CampaignStatus;
}

/** Size an audience before the campaign exists, so the wizard can show a number. */
export class PreviewAudienceDto {
  @ApiProperty({ enum: CAMPAIGN_CHANNELS as unknown as string[] })
  @IsIn(CAMPAIGN_CHANNELS as unknown as string[])
  channelType: CampaignChannel;

  @ApiProperty({ type: AudienceDefinitionDto })
  @IsObject()
  @ValidateNested()
  @Type(() => AudienceDefinitionDto)
  audience: AudienceDefinitionDto;
}

export class ListRecipientsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  @Type(() => Number)
  limit?: number;

  @ApiPropertyOptional({ enum: RECIPIENT_STATUSES as unknown as string[] })
  @IsOptional()
  @IsIn(RECIPIENT_STATUSES as unknown as string[])
  status?: RecipientStatus;
}

/** A one-off send to the author, to check rendering before launching. */
export class TestSendDto {
  @ApiProperty({
    example: 'me@example.com',
    description: 'Email address or E.164 phone, matching the campaign channel.',
  })
  @IsString()
  @Length(3, 320)
  destination: string;
}
