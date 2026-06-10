import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsArray, IsEnum } from 'class-validator';

export class CreateWhatsAppTemplateDto {
  @ApiProperty({ example: 'welcome_template' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'UTILITY', enum: ['UTILITY', 'MARKETING'] })
  @IsString()
  @IsNotEmpty()
  @IsEnum(['UTILITY', 'MARKETING'])
  category: string;

  @ApiProperty({ example: 'vi' })
  @IsString()
  @IsNotEmpty()
  language: string;

  @ApiProperty({ type: [Object] })
  @IsArray()
  components: any[];
}
