import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
    Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { ClsService } from 'nestjs-cls';
import { Request } from 'express';
import { SessionService, SessionData } from '../../auth/services/session.service';

/**
 * TenantInterceptor resolves tenant context from:
 *   1. x-tenant-id header (internal calls / dev / test)
 *   2. BFF session cookie (sid → SessionService → userId)
 *   3. Bearer JWT (nest-keycloak-connect populates req.user)
 *
 * Whichever source provides a tenantId first wins.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
    private readonly logger = new Logger(TenantInterceptor.name);

    constructor(
        private readonly cls: ClsService,
        private readonly sessionService: SessionService,
    ) { }

    async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
        const request = context.switchToHttp().getRequest<Request>();

        // ── 1. Explicit header (highest priority: internal / dev / test) ──
        let tenantId = this.extractHeader(request, 'x-tenant-id');

        // ── 2. BFF session cookie ──
        const sid = (request as any).cookies?.['sid'];
        if (sid) {
            try {
                const session: SessionData | null = await this.sessionService.getSession(sid);
                if (session) {
                    // Decode access token to get user claims
                    const payload = this.decodeJwt(session.accessToken);
                    this.cls.set('userId', payload?.sub);
                    this.cls.set('email', payload?.email);
                    this.cls.set('sid', sid);

                    if (!tenantId && payload?.tenantId) {
                        tenantId = payload.tenantId;
                    }
                }
            } catch (e) {
                this.logger.warn(`Failed to resolve BFF session: ${(e as Error).message}`);
            }
        }

        // ── 3. Bearer JWT (populated by nest-keycloak-connect AuthGuard) ──
        const user = (request as any).user;

        console.log("user", user);
        if (user) {
            if (!tenantId && user.tenantId) {
                tenantId = user.tenantId;
            }
            this.cls.set('user', user);
            if (!this.cls.get('userId')) {
                this.cls.set('userId', user.sub);
            }
            if (!this.cls.get('email')) {
                this.cls.set('email', user.email);
            }
        }

        // ── Store resolved tenantId (null = no tenant context) ──
        if (tenantId) {
            this.cls.set('activeTenantId', tenantId);
            this.cls.set('tenantId', tenantId);
        }

        return next.handle();
    }

    private extractHeader(req: Request, name: string): string | undefined {
        const value = req.headers[name];
        if (Array.isArray(value)) return value[0];
        return value;
    }

    private decodeJwt(token: string): any {
        try {
            const base64 = token.split('.')[1];
            return JSON.parse(Buffer.from(base64, 'base64url').toString('utf-8'));
        } catch {
            return null;
        }
    }
}
