import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly cls: ClsService,
  ) { }

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;

    const ctx = host.switchToHttp();
    const request = ctx.getRequest();

    const httpStatus =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const correlationId = this.cls.getId();

    // Extract message and error code if available
    let message = 'Internal server error';
    let errorCode = 'INTERNAL_SERVER_ERROR';
    let errors = null;

    if (exception instanceof HttpException) {
      const response = exception.getResponse() as any;
      message = response.message || exception.message;
      errorCode = response.error || HttpStatus[httpStatus];
      errors = response.errors || null;
    } else if (exception instanceof Error) {
      message = process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : exception.message;
    }

    const responseBody = {
      errorCode,
      message,
      errors,
      timestamp: new Date().toISOString(),
      path: httpAdapter.getRequestUrl(request),
      correlationId,
    };

    // Log the error with correlation ID and User ID
    const userId = request.user?.id || 'anonymous';
    const isProduction = process.env.NODE_ENV === 'production';

    if (httpStatus >= 500) {
      this.logger.error(
        `[${correlationId}] [User:${userId}] ${httpAdapter.getRequestMethod(request)} ${httpAdapter.getRequestUrl(request)}`,
        isProduction
          ? exception instanceof Error
            ? exception.message
            : String(exception)
          : exception instanceof Error
            ? exception.stack
            : String(exception),
      );
    } else {
      this.logger.warn(
        `[${correlationId}] [User:${userId}] ${httpAdapter.getRequestMethod(request)} ${httpAdapter.getRequestUrl(request)} - ${message}`,
      );
    }

    httpAdapter.reply(ctx.getResponse(), responseBody, httpStatus);
  }
}
