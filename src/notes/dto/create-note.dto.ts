import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateNoteDto {
  @IsString()
  @IsOptional()
  @MaxLength(200)
  title?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000)
  content: string;
}
