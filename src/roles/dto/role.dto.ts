import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { PlatformRoleEnum } from '../platform-role.enum';

export class RoleDto {
  @ApiProperty({ enum: PlatformRoleEnum, example: PlatformRoleEnum.USER })
  @IsEnum(PlatformRoleEnum)
  id: PlatformRoleEnum;
}
