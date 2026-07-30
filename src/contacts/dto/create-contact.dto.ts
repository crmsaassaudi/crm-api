import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  IsArray,
  IsBoolean,
  IsDateString,
} from 'class-validator';
import {
  TransformEmails,
  TransformPhones,
} from '../../common/identity/identity-normalizer';

export class CreateContactDto {
  @ApiProperty({ example: 'Nguyễn' })
  @IsString()
  firstName: string;

  @ApiProperty({ example: 'Toàn' })
  @IsString()
  lastName: string;

  @ApiProperty({ example: 'AntBuddy' })
  @IsOptional()
  @IsString()
  companyName?: string;

  @ApiProperty({ example: 'IT' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({ example: '6a04ae41e74cd5dfaeac8a4b' })
  @IsOptional()
  @IsString()
  statusId?: string;

  @ApiProperty({ example: '6a04ae41e74cd5dfaeac8a4a' })
  @IsOptional()
  @IsString()
  lifecycleStageId?: string;

  @ApiProperty({ example: '6a04ae41e74cd5dfaeac8a4c' })
  @IsOptional()
  @IsString()
  sourceId?: string;

  @ApiProperty({ example: 'CEO' })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiProperty({ example: '123 Main St' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({ example: '1990-01-01' })
  @IsOptional()
  @IsDateString()
  birthday?: Date;

  @ApiProperty({ example: '6a04ae41e74cd5dfaeac8a4d' })
  @IsOptional()
  @IsString()
  accountId?: string;

  @ApiProperty({ example: 'user-1' })
  @IsOptional()
  @IsString()
  ownerId?: string;

  // Shape is validated against the tenant's custom_fields registry by
  // CustomFieldValueValidator; @IsObject only rejects the obviously wrong types
  // (array, string) that would otherwise be written into the Mixed column.
  @ApiProperty({ example: { lead_score: 100 } })
  @IsOptional()
  @IsObject()
  customFields?: Record<string, any>;

  // Normalised inside the global ValidationPipe, so no controller, service or
  // repository can ever observe the raw client value. This is what makes a
  // UI-entered address comparable with an imported one — see
  // common/identity/identity-normalizer.ts.
  @ApiProperty({ example: ['test@example.com'] })
  @IsOptional()
  @Transform(TransformEmails)
  @IsArray()
  @IsEmail({}, { each: true })
  emails?: string[];

  @ApiProperty({ example: ['0911019999'] })
  @IsOptional()
  @Transform(TransformPhones)
  @IsArray()
  @IsString({ each: true })
  phones?: string[];

  @ApiProperty({ example: true })
  @IsOptional()
  @IsBoolean()
  emailOptIn?: boolean;

  @ApiProperty({ example: false })
  @IsOptional()
  @IsBoolean()
  smsOptIn?: boolean;

  @ApiProperty({ example: false })
  @IsOptional()
  @IsBoolean()
  doNotCall?: boolean;

  @ApiProperty({ example: ['enterprise', 'webinar'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({
    example: [{ channelType: 'Facebook', senderId: 'psid_123456' }],
  })
  @IsOptional()
  @IsArray()
  omniIdentities?: Array<{ channelType: string; senderId: string }>;

  // `isShadow` is deliberately NOT accepted from clients. It is set only by
  // ShadowContactService when the omni pipeline auto-creates a contact from an
  // inbound message, and cleared by the promotion rule in ContactsService.
  // A client-settable shadow flag let a caller create records that the UI
  // treats as provisional and that reports exclude (`$eq: ['$isShadow', false]`
  // in contact-report.service.ts) — i.e. write records that do not show up in
  // the numbers. `forbidNonWhitelisted` now rejects the field outright.

  // ────────────────── SOCIAL PROFILES ──────────────────

  @ApiProperty({ example: 'https://linkedin.com/in/johndoe' })
  @IsOptional()
  @IsString()
  linkedinUrl?: string;

  @ApiProperty({ example: 'https://x.com/johndoe' })
  @IsOptional()
  @IsString()
  twitterUrl?: string;

  @ApiProperty({ example: 'https://instagram.com/johndoe' })
  @IsOptional()
  @IsString()
  instagramUrl?: string;

  @ApiProperty({ example: 'https://tiktok.com/@johndoe' })
  @IsOptional()
  @IsString()
  tiktokUrl?: string;

  @ApiProperty({ example: 'https://youtube.com/@johndoe' })
  @IsOptional()
  @IsString()
  youtubeUrl?: string;

  @ApiProperty({ example: 'https://github.com/johndoe' })
  @IsOptional()
  @IsString()
  githubUrl?: string;
}
