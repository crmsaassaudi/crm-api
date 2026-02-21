import { ApiProperty } from '@nestjs/swagger';
import {
    IsEmail,
    IsNotEmpty,
    IsString,
    MinLength,
    MaxLength,
    Matches,
} from 'class-validator';

export class RegisterTenantDto {
    @ApiProperty({ example: 'admin@toancorp.com' })
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @ApiProperty({ example: 'Password123!' })
    @IsString()
    @IsNotEmpty()
    @MinLength(8)
    @Matches(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&\-_#])[A-Za-z\d@$!%*?&\-_#]{8,}$/,
        {
            message:
                'password must contain at least one uppercase letter, one lowercase letter, one number, and one special character',
        },
    )
    password: string;

    @ApiProperty({ example: 'Đại Toàn' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    fullName: string;

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
