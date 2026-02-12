import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional } from 'class-validator';
import { RoleDto } from '../../roles/dto/role.dto';
import { Transform, Type } from 'class-transformer';
import { lowerCaseTransformer } from '../../utils/transformers/lower-case.transformer';

export class InviteUserDto {
    @ApiProperty({ example: 'test1@example.com' })
    @Transform(lowerCaseTransformer)
    @IsNotEmpty()
    @IsEmail()
    email: string;

    @ApiPropertyOptional({ type: RoleDto })
    @IsOptional()
    @Type(() => RoleDto)
    role?: RoleDto | null;
}
