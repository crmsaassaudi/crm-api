import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { StatusEnum } from '../statuses.enum';

export class StatusDto {
  @ApiProperty({ enum: StatusEnum, example: StatusEnum.active })
  @IsEnum(StatusEnum)
  id: StatusEnum;
}
