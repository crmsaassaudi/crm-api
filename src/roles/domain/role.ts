import { ApiProperty } from '@nestjs/swagger';
import { Allow } from 'class-validator';
import { PlatformRoleEnum } from '../platform-role.enum';

export class Role {
  @Allow()
  @ApiProperty({
    type: String,
    enum: PlatformRoleEnum,
    example: PlatformRoleEnum.USER,
  })
  id: PlatformRoleEnum;

  @Allow()
  @ApiProperty({
    type: String,
    example: 'USER',
  })
  name?: string;
}
