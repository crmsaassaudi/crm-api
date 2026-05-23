import { IsEmail, IsOptional, IsString } from 'class-validator';

export class CheckDuplicateContactDto {
  @IsOptional()
  @IsEmail()
  emails?: string;

  @IsOptional()
  @IsString()
  phones?: string;

  @IsOptional()
  @IsString()
  excludeId?: string;
}
