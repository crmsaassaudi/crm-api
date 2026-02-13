import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MinLength, Matches, IsEnum } from 'class-validator';

export enum TenantPlan {
    FREE = 'FREE',
    PRO = 'PRO',
    ENTERPRISE = 'ENTERPRISE',
}

export class TenantOnboardingDto {
    @ApiProperty({ example: 'Tech Startup VN' })
    @IsString()
    @IsNotEmpty()
    companyName: string;

    @ApiProperty({ example: 'techstartup' })
    @IsString()
    @IsNotEmpty()
    @Matches(/^[a-z0-9-]+$/, {
        message: 'Subdomain must contain only lowercase letters, numbers, and hyphens',
    })
    subdomain: string;

    @ApiProperty({ example: 'ceo@techstartup.vn' })
    @IsEmail()
    @IsNotEmpty()
    adminEmail: string;

    @ApiProperty({ example: 'Nguyen' })
    @IsString()
    @IsNotEmpty()
    adminFirstName: string;

    @ApiProperty({ example: 'Van A' })
    @IsString()
    @IsNotEmpty()
    adminLastName: string;

    @ApiProperty({ example: 'PRO', enum: TenantPlan })
    @IsEnum(TenantPlan)
    plan: TenantPlan;
}
