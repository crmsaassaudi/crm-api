import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';

const HEADER_IN = 'x-request-id';
const HEADER_OUT = 'X-Request-Id';

/**
 * CorrelationIdInterceptor — ensures every request has a stable correlation
 * ID that propagates into CLS (so logger.format can pick it up), and
 * echoes it back on the response so the client can quote it in support
 * tickets.
 *
 * Priority:
 *   1. Incoming `X-Request-Id` header (typically set by an upstream LB).
 *   2. UUID v4 generated here.
 *
 * The CLS service's built-in `getId()` is also seeded with the same value
 * so winston.config's `clsService.getId()` matches what we send back to
 * the client and what we put in logs.
 */
@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  constructor(private readonly cls: ClsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const httpCtx = context.switchToHttp();
    const req = httpCtx.getRequest<Request | undefined>();
    const res = httpCtx.getResponse<Response | undefined>();

    if (!req) return next.handle();

    const incoming = (req.headers[HEADER_IN] as string | undefined)?.trim();
    const correlationId =
      incoming && incoming.length <= 128 ? incoming : randomUUID();

    this.cls.set('correlationId', correlationId);
    // Also push to ClsService's internal id slot so logger.getId() lines up.
    try {
      (this.cls as any).setId?.(correlationId);
    } catch {
      /* nestjs-cls versions without setId — fine */
    }

    if (res && typeof res.setHeader === 'function') {
      res.setHeader(HEADER_OUT, correlationId);
    }

    return next.handle();
  }
}
