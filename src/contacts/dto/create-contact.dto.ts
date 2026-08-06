import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsISO31661Alpha2,
  IsObject,
  IsOptional,
  IsString,
  IsArray,
  IsBoolean,
  IsDateString,
  MaxLength,
} from 'class-validator';
import { TransformEmails } from '../../common/identity/identity-normalizer';

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

  @ApiProperty({ example: 'Riyadh' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  /**
   * ISO-3166-1 alpha-2. A code, not a display name: a segment written against
   * "Saudi Arabia" breaks the moment someone types "KSA", and a two-letter code
   * is the only form that survives import, i18n and reporting unchanged.
   */
  @ApiProperty({
    example: 'SA',
    description: 'ISO-3166-1 alpha-2 country code',
  })
  @IsOptional()
  @IsISO31661Alpha2()
  country?: string;

  @ApiProperty({ example: 'shopify_cust_8471' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  externalId?: string;

  @ApiProperty({ example: 'shopify' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  externalSource?: string;

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

  // Emails normalise inside the global ValidationPipe: lower-case + trim needs
  // no tenant context, so no layer below can observe a raw value.
  @ApiProperty({ example: ['test@example.com'] })
  @IsOptional()
  @Transform(TransformEmails)
  @IsArray()
  @IsEmail({}, { each: true })
  emails?: string[];

  /**
   * Phones are NOT normalised here.
   *
   * Promoting `0501234567` to `+966501234567` requires the tenant's dialling
   * code, and a `@Transform` is a static function with no access to the request's
   * tenant. Normalising here without it stored the national form while the import
   * worker — which does read the setting — stored E.164, so the same person
   * entered through the UI and through a CSV produced two contacts that the
   * equality-based dedup gate and the identity unique index could both never
   * compare. ContactsService normalises instead, where the setting is reachable.
   */
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

  /**
   * Priority customer.
   *
   * The flag existed everywhere except here: the schema declares it, the mapper
   * maps it, merge survivorship ORs it across a merge, two indexes are built on
   * it, the filter whitelist accepts it, and the omni pipeline looks it up per
   * inbound message. It was simply not accepted from a client, so nothing could
   * ever set it — which is why every reader downstream (the inbox VIP filter, the
   * `segment: 'VIP'` routing context) was reading a value that was always false
   * without anyone noticing the readers were also broken.
   */
  @ApiProperty({ example: false, description: 'Priority (VIP) customer' })
  @IsOptional()
  @IsBoolean()
  isVIP?: boolean;

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
