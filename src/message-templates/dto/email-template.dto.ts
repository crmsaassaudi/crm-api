import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class CreateEmailTemplateDto {
  @ApiProperty({ example: 'welcome_email' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'Welcome to our service!' })
  @IsString()
  @IsNotEmpty()
  subject: string;

  @ApiProperty({ example: '<h1>Hello {{contact.name}}</h1>' })
  @IsString()
  @IsNotEmpty()
  htmlContent: string;

  @ApiProperty({ example: '{}', required: false })
  @IsString()
  @IsOptional()
  designJson?: string;
}

export class UpdateEmailTemplateDto {
  @ApiProperty({ example: 'Welcome to our service!', required: false })
  @IsString()
  @IsOptional()
  subject?: string;

  @ApiProperty({ example: '<h1>Hello {{contact.name}}</h1>', required: false })
  @IsString()
  @IsOptional()
  htmlContent?: string;

  @ApiProperty({ example: '{}', required: false })
  @IsString()
  @IsOptional()
  designJson?: string;
}
