import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import {
  CONTACT_RELATION_TYPES,
  ContactRelationType,
} from '../relations/contact-relation.schema';

export class CreatePersonRelationDto {
  @ApiProperty({
    description: 'The other person in the relationship.',
    example: '60d0fe4f5311236168a109cb',
  })
  @IsString()
  @IsNotEmpty()
  toContactId: string;

  @ApiProperty({ enum: CONTACT_RELATION_TYPES, example: 'reports_to' })
  @IsIn(CONTACT_RELATION_TYPES as unknown as string[])
  relationType: ContactRelationType;

  @ApiPropertyOptional({
    description: 'Wording for relationType "custom". Required for that type.',
    example: 'Golf partner',
  })
  @IsOptional()
  @IsString()
  customLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateAffiliationDto {
  @ApiProperty({ example: '60d0fe4f5311236168a109cc' })
  @IsString()
  @IsNotEmpty()
  accountId: string;

  @ApiPropertyOptional({
    description: 'Role AT THIS COMPANY — may differ per affiliation.',
    example: 'Procurement lead',
  })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({ example: 'Head of IT' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({
    description:
      'Mirrored into contact.accountId. The first affiliation is primary ' +
      'automatically, so a contact never has a company and a null accountId.',
  })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiPropertyOptional({ example: '2024-01-15' })
  @IsOptional()
  @IsDateString()
  startedAt?: Date;
}

export class UpdateAffiliationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startedAt?: Date;

  @ApiPropertyOptional({
    description:
      'Setting this makes the affiliation a FORMER one without deleting it — ' +
      '"who used to work at Acme" stays answerable. Pass null to reinstate.',
    example: '2026-03-31',
  })
  @IsOptional()
  @IsDateString()
  endedAt?: Date | null;
}
