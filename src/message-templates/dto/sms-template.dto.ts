import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class CreateSMSTemplateDto {
  @ApiProperty({ example: 'welcome_sms' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'Hello {{contact.name}}, welcome to our CRM.' })
  @IsString()
  @IsNotEmpty()
  message: string;
}

export class UpdateSMSTemplateDto {
  @ApiProperty({
    example: 'Hello {{contact.name}}, welcome to our CRM.',
    required: false,
  })
  @IsString()
  @IsOptional()
  message?: string;
}
