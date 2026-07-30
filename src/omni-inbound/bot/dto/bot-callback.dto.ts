import { Type } from 'class-transformer';
import {
  Allow,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * Validated shape of the callback crm-bot POSTs to `/v1/bot-callback/reply`.
 *
 * These are classes (not interfaces) on purpose: the global ValidationPipe runs
 * with `whitelist` + `forbidNonWhitelisted`, so only declared properties survive
 * and anything unexpected is rejected with 422 instead of flowing into the
 * Conversation aggregate.
 */

const MAX_TEXT_LENGTH = 8_000;

export class BotReplyButtonDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  id?: string;

  @IsString()
  @MaxLength(1_000)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  value?: string;
}

export class BotReplyMessageDto {
  @IsIn(['text', 'image', 'video', 'audio', 'file'])
  type!: 'text' | 'image' | 'video' | 'audio' | 'file';

  @IsOptional()
  @IsString()
  @MaxLength(MAX_TEXT_LENGTH)
  text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_048)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  mimeType?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BotReplyButtonDto)
  buttons?: BotReplyButtonDto[];

  /**
   * Raw Typebot bubble. Not consumed by crm-api — accepted (and dropped by the
   * serializer) only so older crm-bot builds that still send it don't 422 during
   * a rolling deploy. Remove once every environment runs a bot that strips it.
   */
  @Allow()
  raw?: unknown;
}

export class BotHandoffMetaDto {
  @IsIn(['general', 'group', 'agent'])
  target!: 'general' | 'group' | 'agent';

  @IsOptional()
  @IsString()
  @MaxLength(64)
  groupId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  agentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_TEXT_LENGTH)
  message?: string;
}

export class BotCallbackDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  org!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  conversationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  inboundMessageId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  sessionId?: string;

  @IsIn(['active', 'handoff', 'ended'])
  status!: 'active' | 'handoff' | 'ended';

  /** Only meaningful when status is `ended` — see BotEndedEvent. */
  @IsOptional()
  @IsIn(['flow_completed', 'no_flow_bound'])
  endReason?: 'flow_completed' | 'no_flow_bound';

  @IsBoolean()
  handoff!: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BotReplyMessageDto)
  messages!: BotReplyMessageDto[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => BotHandoffMetaDto)
  handoffMeta?: BotHandoffMetaDto;
}
