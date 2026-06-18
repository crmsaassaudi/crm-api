import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  IsArray,
  IsBoolean,
  IsDateString,
} from 'class-validator';

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

  @ApiProperty({ example: { lead_score: 100 } })
  @IsOptional()
  customFields?: Record<string, any>;

  @ApiProperty({ example: ['test@example.com'] })
  @IsOptional()
  @IsArray()
  @IsEmail({}, { each: true })
  emails?: string[];

  @ApiProperty({ example: ['0911019999'] })
  @IsOptional()
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

  @ApiProperty({ example: true })
  @IsOptional()
  @IsBoolean()
  isShadow?: boolean;

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
