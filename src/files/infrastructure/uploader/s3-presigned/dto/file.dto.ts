import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString } from 'class-validator';

export class FileUploadDto {
  @ApiProperty({ example: 'image.jpg' })
  @IsString()
  fileName: string;

  @ApiProperty({ example: 138723 })
  @IsNumber()
  fileSize: number;

  @ApiProperty({ example: 'image/png', required: false })
  @IsOptional()
  @IsString()
  contentType?: string;
}
