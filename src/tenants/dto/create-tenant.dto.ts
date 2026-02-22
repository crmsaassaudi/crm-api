import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsEmail } from 'class-validator';

export class CreateTenantDto {
  @ApiProperty({ example: 'Acme Corp' })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({ example: 'acme.com' })
  @IsNotEmpty()
  @IsString()
  domain: string;

  @ApiProperty({ example: 'admin@acme.com' })
  @IsNotEmpty()
  @IsEmail()
  adminEmail: string;
}
