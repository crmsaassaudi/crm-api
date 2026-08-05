import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { ResolvedFieldPolicy } from './field-policy';
import { FieldPolicyInterceptor } from './field-policy.interceptor';
import { OBJECT_FIELD_POLICY_KEY } from './object-field-policy.decorator';

const policy = (
  over: Partial<ResolvedFieldPolicy> = {},
): ResolvedFieldPolicy => ({
  hidden: new Set(),
  readOnly: new Set(),
  masking: new Map(),
  required: new Set(),
  ...over,
});

const context = (request: any) =>
  ({
    getHandler: () => 'handler',
    getClass: () => 'class',
    switchToHttp: () => ({ getRequest: () => request }),
  }) as any;

const run = async ({
  object = 'Contact',
  resolved = policy(),
  request = { method: 'GET' },
  response = {},
}: {
  object?: string | undefined;
  resolved?: ResolvedFieldPolicy;
  request?: any;
  response?: any;
} = {}) => {
  const reflector = {
    getAllAndOverride: (key: string) =>
      key === OBJECT_FIELD_POLICY_KEY ? object : undefined,
  } as unknown as Reflector;
  const layouts = { policyFor: jest.fn().mockResolvedValue(resolved) };
  const interceptor = new FieldPolicyInterceptor(reflector, layouts as any);

  return firstValueFrom(
    interceptor.intercept(context(request), { handle: () => of(response) }),
  );
};

describe('FieldPolicyInterceptor', () => {
  describe('responses', () => {
    it('should pass the payload through when the handler declares no object', async () => {
      const result = await run({ object: undefined, response: { a: 1 } });
      expect(result).toEqual({ a: 1 });
    });

    it('should pass the payload through when the tenant configured nothing', async () => {
      const result = await run({ response: { emails: ['a@b.co'] } });
      expect(result).toEqual({ emails: ['a@b.co'] });
    });

    it('should remove a hidden field from a single record', async () => {
      // The setting Object Manager has always offered and the API never applied:
      // `hidden` was read by the browser only, so the value was in the JSON.
      const result = await run({
        resolved: policy({ hidden: new Set(['emails']) }),
        response: { id: '1', emails: ['a@b.co'], title: 'CTO' },
      });
      expect(result).toEqual({ id: '1', title: 'CTO' });
    });

    it('should remove a hidden field from every row of a paginated envelope', async () => {
      const result = await run({
        resolved: policy({ hidden: new Set(['emails']) }),
        response: {
          data: [{ emails: ['a@b.co'] }, { emails: ['c@d.co'] }],
          total: 2,
        },
      });
      expect(result).toEqual({ data: [{}, {}], total: 2 });
    });

    it('should remove a hidden field from a bare array', async () => {
      const result = await run({
        resolved: policy({ hidden: new Set(['title']) }),
        response: [{ title: 'CTO', id: '1' }],
      });
      expect(result).toEqual([{ id: '1' }]);
    });

    it('should mask a string value', async () => {
      const result = await run({
        resolved: policy({ masking: new Map([['phones', 'last_4' as const]]) }),
        response: { phones: '0987654321' },
      });
      expect(result).toEqual({ phones: '****4321' });
    });

    it('should mask every element of a string array', async () => {
      const result = await run({
        resolved: policy({
          masking: new Map([['emails', 'mask_all' as const]]),
        }),
        response: { emails: ['a@b.co', 'c@d.co'] },
      });
      expect(result).toEqual({ emails: ['********', '********'] });
    });

    it('should leave a number alone rather than turning it into asterisks', async () => {
      // The registry does not offer masking on numeric types; reaching here means a
      // stored policy predates that rule, and rewriting the value would break the
      // client's parser.
      const result = await run({
        resolved: policy({
          masking: new Map([['score', 'mask_all' as const]]),
        }),
        response: { score: 42 },
      });
      expect(result).toEqual({ score: 42 });
    });

    it('should not mask a field it already removed', async () => {
      const result = await run({
        resolved: policy({
          hidden: new Set(['emails']),
          masking: new Map([['emails', 'mask_all' as const]]),
        }),
        response: { emails: ['a@b.co'] },
      });
      expect(result).toEqual({});
    });

    it('should serialise a Mongoose document before rewriting it', async () => {
      const document = {
        toJSON: () => ({ id: '1', emails: ['a@b.co'] }),
      };
      const result = await run({
        resolved: policy({ hidden: new Set(['emails']) }),
        response: document,
      });
      expect(result).toEqual({ id: '1' });
    });

    it('should pass a null body through', async () => {
      const result = await run({
        resolved: policy({ hidden: new Set(['emails']) }),
        response: null,
      });
      expect(result).toBeNull();
    });
  });

  describe('write requests', () => {
    it('should refuse a write that names a hidden field', async () => {
      // A caller who cannot see the field can only have constructed the value
      // deliberately; discarding it silently would report success for nothing.
      await expect(
        run({
          resolved: policy({ hidden: new Set(['emails']) }),
          request: { method: 'POST', body: { emails: ['a@b.co'] } },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('should strip a read-only field instead of refusing the write', async () => {
      // A form that round-trips the value it was given must not fail because of a
      // field the user never touched.
      const body = { title: 'CTO', score: 99 };
      await run({
        resolved: policy({ readOnly: new Set(['score']) }),
        request: { method: 'POST', body },
      });
      expect(body).toEqual({ title: 'CTO' });
    });

    it('should leave a GET body alone', async () => {
      const body = { score: 99 };
      await run({
        resolved: policy({ readOnly: new Set(['score']) }),
        request: { method: 'GET', body },
      });
      expect(body).toEqual({ score: 99 });
    });

    it('should tolerate a request with no body', async () => {
      await expect(
        run({
          resolved: policy({ readOnly: new Set(['score']) }),
          request: { method: 'POST' },
        }),
      ).resolves.toBeDefined();
    });

    it('should name every refused field in the message', async () => {
      await expect(
        run({
          resolved: policy({ hidden: new Set(['emails', 'phones']) }),
          request: {
            method: 'PATCH',
            body: { emails: ['a@b.co'], phones: ['1'] },
          },
        }),
      ).rejects.toThrow(/emails, phones/);
    });
  });
});
