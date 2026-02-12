import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Auth')
@Controller('auth')
export class TenantsAuthController {
    constructor(private readonly tenantsService: TenantsService) { }

    @Public()
    @Post('register-tenant')
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Register a new tenant (onboarding)' })
    @ApiResponse({
        status: HttpStatus.CREATED,
        description: 'Tenant registered successfully',
    })
    async registerTenant(@Body() createTenantDto: CreateTenantDto) {
        return this.tenantsService.createTenant_Saga(createTenantDto);
    }
}
