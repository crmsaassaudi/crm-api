import { ApiProperty } from '@nestjs/swagger';
import { Allow } from 'class-validator';
import { StatusEnum } from '../statuses.enum';

export class Status {
  @Allow()
  @ApiProperty({
    type: String,
    enum: StatusEnum,
    example: StatusEnum.active,
  })
  id: StatusEnum;

  @Allow()
  @ApiProperty({
    type: String,
    example: 'active',
  })
  name?: string;
}
