import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * BusinessException — typed exception that carries a machine-readable errorCode.
 *
 * Usage:
 *   throw new BusinessException(TENANT_ERRORS.NOT_FOUND, HttpStatus.NOT_FOUND);
 *   throw new BusinessException(OMNI_ERRORS.REPLY_WINDOW_EXPIRED, HttpStatus.FORBIDDEN, 'Custom detail');
 *
 * The GlobalExceptionFilter serialises it as:
 *   { statusCode: 404, errorCode: 'TENANT_NOT_FOUND', message: '...' }
 *
 * Frontend maps `errorCode` to an i18n key → shows localised message.
 */
export class BusinessException extends HttpException {
  public readonly errorCode: string;

  constructor(
    errorCode: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    message?: string,
  ) {
    const msg = message ?? errorCode.replace(/_/g, ' ').toLowerCase();
    super(
      {
        statusCode: status,
        errorCode,
        message: msg,
      },
      status,
    );
    this.errorCode = errorCode;
  }
}
