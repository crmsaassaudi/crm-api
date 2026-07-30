import { lastValueFrom, of } from 'rxjs';
import {
  applyMask,
  maskValue,
  FIELD_SENSITIVITY,
} from './field-sensitivity.registry';
import { FieldMaskingInterceptor } from './field-masking.interceptor';
import { PrincipalType } from './principal';
import { ContactSchema } from '../../contacts/infrastructure/persistence/document/entities/contact.schema';

describe('field-sensitivity strategies', () => {
  it('should masks email keeping first char + domain', () => {
    expect(applyMask('alice@example.com', 'email')).toBe('a••••@example.com');
  });
  it('should masks phone keeping last 4', () => {
    expect(applyMask('+1 415 555 1234', 'phone')).toBe('••••1234');
  });
  it('should is idempotent (already-masked stays masked)', () => {
    const once = applyMask('alice@example.com', 'email');
    expect(applyMask(once, 'email')).toBe(once);
  });
  it('should maskValue handles arrays of strings', () => {
    expect(maskValue(['a@b.com', 'c@d.com'], 'email')).toEqual([
      applyMask('a@b.com', 'email'),
      applyMask('c@d.com', 'email'),
    ]);
    // non-string members pass through untouched
    expect(maskValue([1, 'a@b.com'], 'email')).toEqual([
      1,
      applyMask('a@b.com', 'email'),
    ]);
  });
});

/**
 * The registry is only as good as the field NAMES in it: the interceptor does a
 * plain `target[field]` lookup, so a name that does not exist on the serialised
 * document masks nothing and fails silently. This suite pins each declared
 * field against the real schema — the check that was missing when `contacts`
 * declared the singular `email`/`phone` while documents carried `emails` and
 * `phones`, leaving the control inert in production with a green CI.
 */
describe('FIELD_SENSITIVITY field names match the schema', () => {
  it('should ensure every contacts field exists on ContactSchema', () => {
    const schemaPaths = new Set(Object.keys(ContactSchema.paths));
    for (const field of FIELD_SENSITIVITY.contacts) {
      expect(schemaPaths).toContain(field.field);
    }
  });

  it('should declare the plural array fields, not the singular forms', () => {
    const names = FIELD_SENSITIVITY.contacts.map((f) => f.field);
    expect(names).toEqual(expect.arrayContaining(['emails', 'phones']));
    expect(names).not.toContain('email');
    expect(names).not.toContain('phone');
  });
});

describe('FieldMaskingInterceptor', () => {
  let reflector: any;
  let authz: any;
  let cls: any;
  let interceptor: FieldMaskingInterceptor;

  const handlerReturning = (data: any) => ({ handle: () => of(data) });
  const ctx = () =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user: { userId: 'u1', tenantId: 't1' } }),
      }),
    }) as any;

  /** A payload shaped like a real serialised Contact. */
  const contact = (overrides: Record<string, any> = {}) => ({
    id: '1',
    firstName: 'Alice',
    lastName: 'Nguyen',
    emails: ['alice@example.com'],
    phones: ['4155551234'],
    ...overrides,
  });

  beforeEach(() => {
    reflector = { get: jest.fn() };
    authz = { canPerformAction: jest.fn() };
    cls = {
      get: jest.fn((k: string) =>
        k === 'userId' ? 'u1' : k === 'tenantId' ? 't1' : undefined,
      ),
    };
    interceptor = new FieldMaskingInterceptor(reflector, authz, cls);
  });

  it('should is a no-op when the handler has no @SensitiveResource', async () => {
    reflector.get.mockReturnValue(undefined);
    const out = await lastValueFrom(
      interceptor.intercept(ctx(), handlerReturning(contact())),
    );
    expect(out.emails).toEqual(['alice@example.com']);
    expect(authz.canPerformAction).not.toHaveBeenCalled();
  });

  it('should masks PII when the principal lacks the unmask permission', async () => {
    reflector.get.mockReturnValue('contacts');
    authz.canPerformAction.mockResolvedValue({ allowed: false });

    const out = await lastValueFrom(
      interceptor.intercept(ctx(), handlerReturning(contact())),
    );
    expect(out.emails).toEqual(['a••••@example.com']);
    expect(out.phones).toEqual(['••••1234']);
  });

  it('should masks every entry of a multi-value identity array', async () => {
    reflector.get.mockReturnValue('contacts');
    authz.canPerformAction.mockResolvedValue({ allowed: false });

    const out = await lastValueFrom(
      interceptor.intercept(
        ctx(),
        handlerReturning(
          contact({
            emails: ['alice@example.com', 'a.nguyen@work.io'],
            phones: ['4155551234', '+84901112222'],
          }),
        ),
      ),
    );
    expect(out.emails).toEqual(['a••••@example.com', 'a•••••••@work.io']);
    expect(out.phones).toEqual(['••••1234', '••••2222']);
  });

  it('should leaves PII intact when the principal holds the unmask permission', async () => {
    reflector.get.mockReturnValue('contacts');
    authz.canPerformAction.mockResolvedValue({ allowed: true });

    const out = await lastValueFrom(
      interceptor.intercept(ctx(), handlerReturning(contact())),
    );
    expect(out.emails).toEqual(['alice@example.com']);
    expect(out.phones).toEqual(['4155551234']);
    // Both contact fields share one unmask permission → evaluated once.
    expect(authz.canPerformAction).toHaveBeenCalledTimes(1);
  });

  it('should ALWAYS masks for an agent principal without any PDP call', async () => {
    reflector.get.mockReturnValue('contacts');
    cls.get.mockImplementation((k: string) =>
      k === 'userId'
        ? 'u1'
        : k === 'tenantId'
          ? 't1'
          : k === 'principalType'
            ? PrincipalType.AGENT
            : undefined,
    );

    const out = await lastValueFrom(
      interceptor.intercept(ctx(), handlerReturning(contact())),
    );
    expect(out.emails).toEqual(['a••••@example.com']);
    expect(authz.canPerformAction).not.toHaveBeenCalled();
  });

  it('should masks inside a paginated { data: [...] } payload', async () => {
    reflector.get.mockReturnValue('contacts');
    authz.canPerformAction.mockResolvedValue({ allowed: false });

    const out = await lastValueFrom(
      interceptor.intercept(
        ctx(),
        handlerReturning({
          data: [
            contact(),
            contact({ id: '2', emails: ['bob@x.io'], phones: [] }),
          ],
          hasNextPage: false,
        }),
      ),
    );
    expect(out.data[0].emails).toEqual(['a••••@example.com']);
    expect(out.data[1].emails).toEqual(['b••@x.io']);
    expect(out.hasNextPage).toBe(false);
  });
});

describe('FieldMaskingInterceptor — nested (dotted) fields', () => {
  let reflector: any;
  let authz: any;
  let cls: any;
  let interceptor: FieldMaskingInterceptor;

  const handlerReturning = (data: any) => ({ handle: () => of(data) });
  const ctx = () =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user: { userId: 'u1', tenantId: 't1' } }),
      }),
    }) as any;

  const conversation = (overrides: Record<string, any> = {}) => ({
    id: 'c1',
    channelType: 'whatsapp',
    customer: {
      externalId: 'psid_1',
      name: 'Alice',
      email: 'alice@example.com',
      phone: '4155551234',
    },
    ...overrides,
  });

  beforeEach(() => {
    reflector = { get: jest.fn().mockReturnValue('omni_channel') };
    authz = {
      canPerformAction: jest.fn().mockResolvedValue({ allowed: false }),
    };
    cls = {
      get: jest.fn((k: string) =>
        k === 'userId' ? 'u1' : k === 'tenantId' ? 't1' : undefined,
      ),
    };
    interceptor = new FieldMaskingInterceptor(reflector, authz, cls);
  });

  it('should mask PII inside a sub-document', async () => {
    // A flat `target[field]` lookup could not reach these, so the registry was unable
    // to describe them however precisely it named them.
    const out = await lastValueFrom(
      interceptor.intercept(ctx(), handlerReturning(conversation())),
    );
    expect(out.customer.email).toBe('a••••@example.com');
    expect(out.customer.phone).toBe('••••1234');
  });

  it('should leave the rest of the sub-document alone', async () => {
    const out = await lastValueFrom(
      interceptor.intercept(ctx(), handlerReturning(conversation())),
    );
    expect(out.customer.name).toBe('Alice');
    expect(out.customer.externalId).toBe('psid_1');
  });

  it('should NOT mutate the source document', async () => {
    // `{ ...item }` copies only the top level, so a naive nested write would reach
    // through into the persisted document. The class promises it never does that.
    const source = conversation();
    await lastValueFrom(interceptor.intercept(ctx(), handlerReturning(source)));
    expect(source.customer.email).toBe('alice@example.com');
    expect(source.customer.phone).toBe('4155551234');
  });

  it('should leave PII intact when the principal may unmask', async () => {
    authz.canPerformAction.mockResolvedValue({ allowed: true });
    const out = await lastValueFrom(
      interceptor.intercept(ctx(), handlerReturning(conversation())),
    );
    expect(out.customer.email).toBe('alice@example.com');
  });

  it('should tolerate a missing sub-document', async () => {
    const out = await lastValueFrom(
      interceptor.intercept(
        ctx(),
        handlerReturning({ id: 'c1', customer: undefined }),
      ),
    );
    expect(out.id).toBe('c1');
  });

  it('should tolerate a sub-document with the field absent', async () => {
    const out = await lastValueFrom(
      interceptor.intercept(
        ctx(),
        handlerReturning({ id: 'c1', customer: { name: 'Alice' } }),
      ),
    );
    expect(out.customer.name).toBe('Alice');
    expect(out.customer.email).toBeUndefined();
  });

  it('should mask inside a paginated list of conversations', async () => {
    const out = await lastValueFrom(
      interceptor.intercept(
        ctx(),
        handlerReturning({ data: [conversation(), conversation()] }),
      ),
    );
    expect(out.data[0].customer.email).toBe('a••••@example.com');
    expect(out.data[1].customer.phone).toBe('••••1234');
  });
});
