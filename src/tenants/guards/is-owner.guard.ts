import { Injectable, CanActivate, ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TenantsService } from '../tenants.service';

@Injectable()
export class IsOwnerGuard implements CanActivate {
    constructor(private readonly tenantsService: TenantsService) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const user = request.user;

        if (!user || !user.id) {
            throw new ForbiddenException('User not authenticated');
        }

        // Extract tenant ID from request params
        const tenantId = request.params.id || request.params.tenantId;

        if (!tenantId) {
            throw new ForbiddenException('Tenant ID not provided');
        }

        // Fetch tenant from database
        const tenant = await this.tenantsService.findById(tenantId);

        if (!tenant) {
            throw new NotFoundException('Tenant not found');
        }

        // Check if user is the owner
        if (tenant.owner !== user.id) {
            throw new ForbiddenException('Only the tenant owner can perform this action');
        }

        return true;
    }
}
