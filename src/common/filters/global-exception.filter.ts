import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { BusinessException } from '../exceptions/business.exception';
import { COMMON_ERRORS } from '../constants/error-code.base';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly cls: ClsService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;

    const ctx = host.switchToHttp();
    const request = ctx.getRequest();

    const httpStatus =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const correlationId = this.cls.getId();

    // Extract message and error code
    const { message, errorCode, errors } = this.extractErrorMetadata(exception);

    const responseBody = {
      statusCode: httpStatus,
      errorCode,
      // `code` is an alias of `errorCode`, not a second concept. The frontend reads
      // `data.code` in `normalizeApiError` and in the channel-support empty-pool
      // retry; this response only ever carried `errorCode`, so `data.code` was
      // always undefined and both readers silently fell through. Emitting both keeps
      // either spelling working instead of requiring a synchronised rename across
      // two apps.
      code: errorCode,
      message,
      errors,
      timestamp: new Date().toISOString(),
      path: httpAdapter.getRequestUrl(request),
      correlationId,
    };

    // Log the error with correlation ID and User ID
    this.logException(
      httpAdapter,
      request,
      correlationId,
      httpStatus,
      errorCode,
      message,
      exception,
    );

    httpAdapter.reply(ctx.getResponse(), responseBody, httpStatus);
  }

  /** Extract structured error metadata from the caught exception. */
  private extractErrorMetadata(exception: unknown): {
    message: string | string[];
    errorCode: string;
    errors: any;
  } {
    if (exception instanceof BusinessException) {
      const response = exception.getResponse() as any;
      return {
        errorCode: exception.errorCode,
        message: response.message ?? exception.message,
        errors: response.errors ?? null,
      };
    }

    if (exception instanceof HttpException) {
      const response = exception.getResponse() as any;
      return {
        message: response.message || exception.message,
        // Accept `code` as well as `errorCode`. Several services throw
        // `new UnprocessableEntityException({ code: '…', message })` — channel
        // support does it five times — and reading only `errorCode` silently
        // discarded those specific codes and replaced them with the generic mapping,
        // so the client could not tell an empty support pool from any other 422.
        errorCode:
          response.errorCode ??
          response.code ??
          this.mapNestExceptionToCode(exception),
        errors: response.errors || null,
      };
    }

    if (exception instanceof Error) {
      return {
        message:
          process.env.NODE_ENV === 'production'
            ? 'Internal server error'
            : exception.message,
        errorCode: COMMON_ERRORS.INTERNAL_ERROR,
        errors: null,
      };
    }

    return {
      message: 'Internal server error',
      errorCode: COMMON_ERRORS.INTERNAL_ERROR,
      errors: null,
    };
  }

  /** Format and emit the appropriate log entry for the exception. */
  private logException(
    httpAdapter: any,
    request: any,
    correlationId: string | undefined,
    httpStatus: number,
    errorCode: string,
    message: string | string[],
    exception: unknown,
  ): void {
    const userId = request.user?.id || 'anonymous';
    const serializedMessage = Array.isArray(message)
      ? message.join(', ')
      : message;
    const method = httpAdapter.getRequestMethod(request);
    const url = httpAdapter.getRequestUrl(request);

    if (httpStatus >= 500) {
      const exceptionName =
        exception instanceof Error ? exception.name : typeof exception;
      const exceptionMessage =
        exception instanceof Error ? exception.message : String(exception);
      const exceptionStack =
        exception instanceof Error ? exception.stack : String(exception);
      const isProduction = process.env.NODE_ENV === 'production';

      const logMessage =
        `[${correlationId}] [User:${userId}] ${method} ${url}` +
        ` - ${errorCode}: ${serializedMessage}; exception=${exceptionName}; detail=${exceptionMessage}`;

      this.logger.error(logMessage, isProduction ? undefined : exceptionStack);
    } else {
      this.logger.warn(
        `[${correlationId}] [User:${userId}] ${method} ${url} - ${errorCode}: ${message}`,
      );
    }
  }

  /**
   * Maps NestJS built-in HttpException subclasses to standardised error codes.
   * Services should progressively migrate to BusinessException for specific codes.
   */
  private mapNestExceptionToCode(exception: HttpException): string {
    if (exception instanceof BadRequestException)
      return COMMON_ERRORS.VALIDATION_ERROR;
    if (exception instanceof NotFoundException)
      return COMMON_ERRORS.ENTITY_NOT_FOUND;
    if (exception instanceof ConflictException) return COMMON_ERRORS.CONFLICT;
    if (exception instanceof ForbiddenException) return COMMON_ERRORS.FORBIDDEN;
    if (exception instanceof UnauthorizedException)
      return COMMON_ERRORS.UNAUTHORIZED;

    // Status-based fallback rather than a longer `instanceof` chain: the chain only
    // covered five classes, so a 422 and a 429 both reported INTERNAL_ERROR — the
    // client could not distinguish a validation failure or a rate limit from a
    // server fault, and `RATE_LIMIT_EXCEEDED` existed in COMMON_ERRORS (and in the
    // frontend's error translations) while nothing could ever emit it. Throttler
    // exceptions in particular never subclass the types above.
    switch (exception.getStatus()) {
      case HttpStatus.UNPROCESSABLE_ENTITY:
      case HttpStatus.BAD_REQUEST:
        return COMMON_ERRORS.VALIDATION_ERROR;
      case HttpStatus.TOO_MANY_REQUESTS:
        return COMMON_ERRORS.RATE_LIMIT_EXCEEDED;
      case HttpStatus.NOT_FOUND:
        return COMMON_ERRORS.ENTITY_NOT_FOUND;
      case HttpStatus.CONFLICT:
        return COMMON_ERRORS.CONFLICT;
      case HttpStatus.FORBIDDEN:
        return COMMON_ERRORS.FORBIDDEN;
      case HttpStatus.UNAUTHORIZED:
        return COMMON_ERRORS.UNAUTHORIZED;
      default:
        return COMMON_ERRORS.INTERNAL_ERROR;
    }
  }
}
