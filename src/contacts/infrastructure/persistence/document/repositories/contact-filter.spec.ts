import { ContactRepository } from './contact.repository';

/**
 * `ALLOWED_FILTER_FIELDS` is a security boundary: it stops a client turning the
 * list-view filter into arbitrary field access on the contacts collection. The
 * `customFields.<key>` support added alongside it therefore has to be validated
 * against the tenant's registry rather than accepting any dotted path — these
 * tests pin that it does, and that a static-whitelist field is still handled
 * exactly as before.
 *
 * Driven through the private resolver by design: it is the single decision point,
 * and exercising it directly means the boundary is tested without a live Mongo.
 */
// A real instance, not `Object.create(prototype)`: `ALLOWED_FILTER_FIELDS` is an
// instance field, so a bare prototype object has no whitelist and every case
// would fail on `undefined.has(...)`. The model and CLS are never touched by the
// resolver, so stubs are enough.
const repo = new ContactRepository({} as any, {} as any) as any;

function resolve(
  filter: { id: string; value: any },
  allowedKeys?: Set<string>,
): [string, any] | null {
  return repo.resolveSingleFilterCondition(filter, allowedKeys);
}

describe('contact filter whitelist — custom fields', () => {
  it('should honour a declared custom-field key', () => {
    // The registry let an admin define a field the product then could not filter,
    // sort or report on. This is the path that closes that.
    const result = resolve(
      { id: 'customFields.segment', value: 'enterprise' },
      new Set(['segment']),
    );
    expect(result?.[0]).toBe('customFields.segment');
  });

  it('should REFUSE a key the tenant never declared', () => {
    expect(
      resolve(
        { id: 'customFields.injected', value: 'x' },
        new Set(['segment']),
      ),
    ).toBeNull();
  });

  it('should refuse every custom-field filter when no registry was supplied', () => {
    // Fail closed: no registry means the repository cannot know what is legitimate.
    expect(resolve({ id: 'customFields.segment', value: 'x' })).toBeNull();
  });

  it('should refuse a bare customFields path with no key', () => {
    expect(
      resolve({ id: 'customFields.', value: 'x' }, new Set(['a'])),
    ).toBeNull();
  });

  it('should not let a nested path smuggle in another field', () => {
    // `customFields.a.$ne` must not resolve — only registry keys do, and the
    // registry holds flat internalKeys.
    expect(
      resolve({ id: 'customFields.a.b', value: 'x' }, new Set(['a'])),
    ).toBeNull();
  });

  it('should escape regex metacharacters in a custom-field value', () => {
    const [, condition] = resolve(
      { id: 'customFields.segment', value: 'a.*b' },
      new Set(['segment']),
    )!;
    expect(condition.$regex).toBe('a\\.\\*b');
  });

  it('should use $in for a multi-value custom-field filter', () => {
    const [, condition] = resolve(
      { id: 'customFields.segment', value: ['a', 'b'] },
      new Set(['segment']),
    )!;
    expect(condition).toEqual({ $in: ['a', 'b'] });
  });

  it('should compare a non-string custom-field value exactly', () => {
    // A number must not become a regex — `{ $regex: 5 }` is not a query.
    const [, condition] = resolve(
      { id: 'customFields.budget', value: 5 },
      new Set(['budget']),
    )!;
    expect(condition).toBe(5);
  });
});

describe('contact filter whitelist — static fields still hold', () => {
  it('should reject a field outside the whitelist', () => {
    expect(resolve({ id: 'ownerId', value: 'u1' })).toBeNull();
    expect(resolve({ id: '__proto__', value: 'x' })).toBeNull();
    expect(resolve({ id: 'tenantId', value: 'other' })).toBeNull();
  });

  it('should map the owner alias onto the real column', () => {
    expect(resolve({ id: 'owner', value: 'u1' })).toEqual(['ownerId', 'u1']);
  });

  it('should anchor an email filter so a partial value cannot match broadly', () => {
    const [, condition] = resolve({ id: 'emails', value: 'a@b.com' })!;
    expect(condition.$regex).toBe('^a@b\\.com$');
  });

  it('should skip a filter with no value', () => {
    expect(resolve({ id: 'companyName', value: '' })).toBeNull();
  });
});
