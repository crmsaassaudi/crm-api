import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';
import { BusinessException } from '../exceptions/business.exception';
import { COMMON_ERRORS } from '../constants/error-code.base';

/**
 * This filter is the middle of a contract that was built on both ends and never
 * joined. It emitted `errorCode`; the frontend read `data.code`, which was never set,
 * so every caller fell back to the server's hardcoded English `message` regardless of
 * the user's language — while `locales/{en,vi,ar}/errors.json` held a translation for
 * each code. These tests pin the joint.
 */
describe('GlobalExceptionFilter', () => {
  let reply: jest.Mock;
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    reply = jest.fn();
    const httpAdapterHost = {
      httpAdapter: {
        reply,
        getRequestUrl: () => '/v1/deals/1',
        getRequestMethod: () => 'GET',
      },
    } as any;
    filter = new GlobalExceptionFilter(httpAdapterHost, {
      getId: () => 'corr-1',
    } as any);
  });

  /** Run an exception through the filter and return the serialised body. */
  function body(exception: unknown): any {
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { id: 'u1' } }),
        getResponse: () => ({}),
      }),
    } as any;
    filter.catch(exception, host);
    // httpAdapter.reply(response, body, status) — the body is the second argument.
    return reply.mock.calls[0][1];
  }

  it('should emit code as an alias of errorCode', () => {
    // The whole disconnect in one assertion: the frontend reads `code`.
    const out = body(new NotFoundException('Deal not found'));
    expect(out.errorCode).toBe(COMMON_ERRORS.ENTITY_NOT_FOUND);
    expect(out.code).toBe(out.errorCode);
  });

  it("should preserve a BusinessException's specific errorCode", () => {
    const out = body(
      new BusinessException('DEAL_ALREADY_WON', HttpStatus.BAD_REQUEST, 'nope'),
    );
    expect(out.errorCode).toBe('DEAL_ALREADY_WON');
    expect(out.code).toBe('DEAL_ALREADY_WON');
    expect(out.message).toBe('nope');
  });

  it('should accept a `code` field on the thrown response, not only `errorCode`', () => {
    // Channel support throws `new UnprocessableEntityException({ code, message })`
    // in five places. Reading only `errorCode` replaced those with the generic
    // mapping, so the client could not tell an empty support pool from any other
    // 422 — and the frontend's allowEmptyPool retry could never fire.
    const out = body(
      new UnprocessableEntityException({
        code: 'CHANNEL_SUPPORT_EMPTY_POOL',
        message: 'nobody would serve this channel',
      }),
    );
    expect(out.errorCode).toBe('CHANNEL_SUPPORT_EMPTY_POOL');
    expect(out.code).toBe('CHANNEL_SUPPORT_EMPTY_POOL');
  });

  it('should map by status when no exception class matches', () => {
    // The old `instanceof` chain covered five classes, so 422 and 429 both reported
    // INTERNAL_ERROR: a validation failure and a rate limit were indistinguishable
    // from a server fault, and RATE_LIMIT_EXCEEDED existed in COMMON_ERRORS (and in
    // the frontend translations) with nothing able to emit it.
    expect(body(new UnprocessableEntityException('bad')).errorCode).toBe(
      COMMON_ERRORS.VALIDATION_ERROR,
    );
    reply.mockClear();
    expect(
      body(new HttpException('slow down', HttpStatus.TOO_MANY_REQUESTS))
        .errorCode,
    ).toBe(COMMON_ERRORS.RATE_LIMIT_EXCEEDED);
  });

  it('should keep the existing class mappings', () => {
    expect(body(new BadRequestException('x')).errorCode).toBe(
      COMMON_ERRORS.VALIDATION_ERROR,
    );
    reply.mockClear();
    expect(body(new ForbiddenException('x')).errorCode).toBe(
      COMMON_ERRORS.FORBIDDEN,
    );
  });

  it('should fall back to INTERNAL_ERROR for a non-HTTP error', () => {
    const out = body(new Error('boom'));
    expect(out.errorCode).toBe(COMMON_ERRORS.INTERNAL_ERROR);
    expect(out.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  });
});
