import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  IsArray,
  IsBoolean,
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

  @ApiProperty({ example: 'new' })
  @IsString()
  status: string;

  @ApiProperty({ example: 'lead' })
  @IsString()
  lifecycleStage: string;

  @ApiProperty({ example: '2' })
  @IsOptional()
  @IsString()
  source?: string;

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
  birthday?: Date;

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

  @ApiProperty({ example: ['0123456789'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  phones?: string[];

  @ApiProperty({ example: false })
  @IsOptional()
  @IsBoolean()
  isConverted?: boolean;

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
}
