import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { ClsService } from 'nestjs-cls';
import { Request } from 'express';

/**
 * TenantInterceptor extracts tenant ID from request headers
 * and stores it in CLS for automatic tenant filtering
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
    constructor(private readonly cls: ClsService) { }

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const request = context.switchToHttp().getRequest<Request>();

        // 1. Try to get tenant ID from header
        let tenantId = request.headers['x-tenant-id'];
        if (Array.isArray(tenantId)) {
            tenantId = tenantId[0];
        }

        // 2. If not in header, try to extract from JWT token
        const user = (request as any).user;
        if (!tenantId) {
            if (user && user.tenantId) {
                tenantId = user.tenantId;
            }
        }

        if (user) {
            this.cls.set('user', user);
        }

        // 3. Store in CLS for use in repositories
        if (tenantId) {
            this.cls.set('activeTenantId', tenantId);
            this.cls.set('tenantId', tenantId); // Also set as tenantId for compatibility
        }

        return next.handle();
    }
}
