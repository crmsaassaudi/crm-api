import { ApiProperty } from '@nestjs/swagger';
import {
    IsNotEmpty,
    IsString,
    MinLength,
    MaxLength,
    Matches,
} from 'class-validator';

export class OnboardExistingUserDto {
    @ApiProperty({ example: 'Toan Corp' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(150)
    organizationName: string;

    @ApiProperty({ example: 'toancorp' })
    @IsString()
    @IsNotEmpty()
    @MinLength(3)
    @MaxLength(63)
    @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, {
        message:
            'organizationAlias must contain only lowercase letters, numbers, and hyphens, and must start and end with a letter or number',
    })
    organizationAlias: string;
}
