import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const start = process.hrtime.bigint();

    return next.handle().pipe(
      finalize(() => {
        const durationSeconds =
          Number(process.hrtime.bigint() - start) / 1_000_000_000;

        this.metricsService.recordHttpRequest({
          method: request.method ?? 'UNKNOWN',
          route: this.resolveRouteLabel(request),
          statusCode: response.statusCode ?? 0,
          durationSeconds,
        });
      }),
    );
  }

  private resolveRouteLabel(request: any): string {
    const routePath = request.route?.path;
    if (routePath) {
      return `${request.baseUrl ?? ''}${routePath}`;
    }

    const rawUrl = request.originalUrl ?? request.url ?? 'unknown';
    return String(rawUrl).split('?')[0];
  }
}
