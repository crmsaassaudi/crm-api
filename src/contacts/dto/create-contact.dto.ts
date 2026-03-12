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

  @ApiProperty({ example: 'user-1' })
  @IsOptional()
  @IsString()
  owner?: string;

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
}
