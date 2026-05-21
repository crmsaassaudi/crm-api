import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Request } from 'express';
import { SystemSettingsService } from './system-settings.service';
import { extractClientIp, isIpWhitelisted } from './ip-whitelist.util';

@Injectable()
export class MaintenanceModeGuard implements CanActivate {
  constructor(private readonly systemSettingsService: SystemSettingsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    if (this.shouldBypass(request)) {
      return true;
    }

    const maintenance =
      await this.systemSettingsService.getMaintenanceModeSnapshot();
    if (!maintenance.enabled) {
      return true;
    }

    const clientIp = extractClientIp(request);
    if (isIpWhitelisted(clientIp, maintenance.whitelistedIPs)) {
      return true;
    }

    throw new ServiceUnavailableException({
      code: 'MAINTENANCE_MODE',
      errorCode: 'MAINTENANCE_MODE',
      message: 'System is currently in maintenance mode',
      details: {
        clientIp,
      },
    });
  }

  private shouldBypass(request: Request): boolean {
    if (request.method === 'OPTIONS') {
      return true;
    }

    const path = (request.originalUrl || request.url || '').toLowerCase();

    return (
      path === '/' ||
      path === '/api' ||
      path === '/api/' ||
      path.includes('/health') ||
      path.includes('/metrics') ||
      path.startsWith('/docs') ||
      path.startsWith('/queues')
    );
  }
}
