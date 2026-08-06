import { BadRequestException } from '@nestjs/common';
import { ContactRepository } from './contact.repository';
import { ContactSchema } from '../entities/contact.schema';
import {
  compileContactFilter,
  parseContactFilter,
} from '../../../../filters/contact-filter';
import { CONTACT_SORTABLE_FIELDS } from '../../../../dto/query-contact.dto';

/**
 * The filter compiler is a security boundary: it stops a client turning the
 * list-view filter into arbitrary field access on the contacts collection. The
 * `customFields.<key>` support has to be validated against the tenant's registry
 * rather than accepting any dotted path.
 *
 * It is also a CORRECTNESS boundary, which the whitelist it replaced was not.
 * The old resolver assigned each condition onto `where[field]`, dropped every
 * falsy value, offered no operators, and silently ignored any field missing from
 * its list — including `firstName`/`lastName`, which the UI offered. All four
 * are pinned as failures below so none of them can come back.
 */
const compile = (
  input: unknown,
  allowedKeys?: Set<string>,
): Record<string, any> | null => {
  const group = parseContactFilter(input);
  return group ? (compileContactFilter(group, allowedKeys) as any) : null;
};

/** The single `$and` clause a one-condition filter produces. */
const single = (input: unknown, allowedKeys?: Set<string>) =>
  compile(input, allowedKeys)?.$and?.[0];

// A real instance: the model and CLS are never touched by `buildListWhere`.
const repo = new ContactRepository({} as any, {} as any) as any;

describe('contact filter compiler — custom fields', () => {
  it('should honour a declared custom-field key', () => {
    // The registry let an admin define a field the product then could not filter,
    // sort or report on. This is the path that closes that.
    expect(
      single(
        [
          {
            field: 'customFields.segment',
            operator: 'eq',
            value: 'enterprise',
          },
        ],
        new Set(['segment']),
      ),
    ).toEqual({ 'customFields.segment': 'enterprise' });
  });

  it('should REFUSE a key the tenant never declared', () => {
    expect(() =>
      single(
        [{ field: 'customFields.injected', operator: 'eq', value: 'x' }],
        new Set(['segment']),
      ),
    ).toThrow(BadRequestException);
  });

  it('should refuse every custom-field filter when no registry was supplied', () => {
    // Fail closed: no registry means the repository cannot know what is legitimate.
    expect(() =>
      single([{ field: 'customFields.segment', operator: 'eq', value: 'x' }]),
    ).toThrow(BadRequestException);
  });

  it('should refuse a bare customFields path with no key', () => {
    expect(() =>
      single(
        [{ field: 'customFields.', operator: 'eq', value: 'x' }],
        new Set(['a']),
      ),
    ).toThrow(BadRequestException);
  });

  it('should not let a nested path smuggle in another field', () => {
    // `customFields.a.b` must not resolve — only registry keys do, and the
    // registry holds flat internalKeys.
    expect(() =>
      single(
        [{ field: 'customFields.a.b', operator: 'eq', value: 'x' }],
        new Set(['a']),
      ),
    ).toThrow(BadRequestException);
  });

  it('should escape regex metacharacters in a custom-field value', () => {
    expect(
      single(
        [
          {
            field: 'customFields.segment',
            operator: 'contains',
            value: 'a.*b',
          },
        ],
        new Set(['segment']),
      ),
    ).toEqual({
      'customFields.segment': { $regex: 'a\\.\\*b', $options: 'i' },
    });
  });

  it('should use $in for a multi-value custom-field filter', () => {
    expect(
      single(
        [{ field: 'customFields.segment', operator: 'in', value: ['a', 'b'] }],
        new Set(['segment']),
      ),
    ).toEqual({ 'customFields.segment': { $in: ['a', 'b'] } });
  });
});

describe('contact filter compiler — field boundary', () => {
  it('should reject a field outside the registry', () => {
    for (const field of [
      '__proto__',
      'tenantId',
      'deletedAt',
      'stageHistory',
    ]) {
      expect(() => single([{ field, operator: 'eq', value: 'x' }])).toThrow(
        BadRequestException,
      );
    }
  });

  it('should map the owner alias onto the real column', () => {
    expect(single([{ field: 'owner', operator: 'eq', value: 'u1' }])).toEqual({
      ownerId: 'u1',
    });
  });

  it('should accept firstName and lastName', () => {
    // The regression that made the list lie: the UI offered these, the old
    // whitelist did not contain them, so the request succeeded and returned every
    // contact while the chip claimed a filter was applied.
    expect(
      single([{ field: 'firstName', operator: 'contains', value: 'Ahmed' }]),
    ).toEqual({ firstName: { $regex: 'Ahmed', $options: 'i' } });
  });

  it('should reject an operator the field type cannot answer', () => {
    // `contains` on a date compiles to a regex against a Date — a query that
    // matches nothing and reports no error.
    expect(() =>
      single([{ field: 'createdAt', operator: 'contains', value: 'x' }]),
    ).toThrow(BadRequestException);
  });
});

describe('contact filter compiler — the four silent failures', () => {
  it('should keep two conditions on the same field instead of overwriting', () => {
    // `where[field] = condition` meant "tag = VIP AND tag = Riyadh" became
    // "tag = Riyadh".
    const compiled = compile([
      { field: 'tags', operator: 'eq', value: 'vip' },
      { field: 'tags', operator: 'eq', value: 'riyadh' },
    ]);
    expect(compiled?.$and).toEqual([{ tags: 'vip' }, { tags: 'riyadh' }]);
  });

  it('should honour a false boolean instead of dropping it', () => {
    // `if (!f.value) return null` silently discarded `isVIP = false`, so the
    // filter appeared applied over the unfiltered list.
    expect(single([{ field: 'isVIP', operator: 'eq', value: false }])).toEqual({
      isVIP: false,
    });
  });

  it('should honour zero as a numeric value', () => {
    expect(single([{ field: 'score', operator: 'lte', value: 0 }])).toEqual({
      score: { $lte: 0 },
    });
  });

  it('should support the operators a B2C segment needs', () => {
    expect(
      single([{ field: 'totalRevenue', operator: 'gt', value: 1000 }]),
    ).toEqual({ totalRevenue: { $gt: 1000 } });

    const dormant = single([
      { field: 'lastActivityAt', operator: 'not_in_last_days', value: 30 },
    ]);
    // Expressed as NOT(recent) rather than `$lt`, so a contact that has never
    // been active — the most dormant kind — is included rather than excluded.
    expect(Object.keys(dormant.lastActivityAt)).toEqual(['$not']);
  });
});

describe('contact filter compiler — grouping', () => {
  it('should OR a group whose match is "any"', () => {
    const compiled = compile({
      match: 'any',
      conditions: [
        { field: 'isVIP', operator: 'eq', value: true },
        { field: 'totalRevenue', operator: 'gte', value: 5000 },
      ],
    });
    expect(compiled).toEqual({
      $or: [{ isVIP: true }, { totalRevenue: { $gte: 5000 } }],
    });
  });
});

describe('contact filter compiler — legacy shape', () => {
  it('should still read the flat {id, value} list the UI has always sent', () => {
    expect(single([{ id: 'companyName', value: 'Acme' }])).toEqual({
      companyName: { $regex: 'Acme', $options: 'i' },
    });
    expect(single([{ id: 'lifecycleStageId', value: 'customer' }])).toEqual({
      lifecycleStageId: 'customer',
    });
  });

  it('should treat an empty legacy value as no condition, not as a match on ""', () => {
    // The UI emits one while the user is still choosing a value.
    expect(compile([{ id: 'companyName', value: '' }])).toBeNull();
  });

  it('should refuse a malformed expression rather than ignoring it', () => {
    expect(() => parseContactFilter('{not json')).toThrow(BadRequestException);
  });
});

describe('contact list search query shape', () => {
  it('should use indexed normalised equality for a full email search', () => {
    const where = repo.buildListWhere({ search: ' Person@Example.COM ' });

    expect(where.emails).toBe('person@example.com');
    expect(where).not.toHaveProperty('$or');
    expect(where).not.toHaveProperty('$text');
  });

  it('should keep text search for names', () => {
    const where = repo.buildListWhere({ search: 'Nguyen Van A' });

    expect(where.$text).toEqual({ $search: 'Nguyen Van A' });
  });

  it('should compose a segment with the list filters instead of replacing them', () => {
    const where = repo.buildListWhere({
      __segmentFilter: { tags: 'vip' },
      filters: [{ field: 'country', operator: 'eq', value: 'SA' }],
    });
    expect(where.$and).toEqual([
      { tags: 'vip' },
      { $and: [{ country: 'SA' }] },
    ]);
  });

  it('should prefix the text index with tenantId', () => {
    const textIndex = ContactSchema.indexes().find(
      ([, options]) => options.name === 'contact_text_search',
    );
    expect(textIndex?.[0]).toEqual({
      tenantId: 1,
      firstName: 'text',
      lastName: 'text',
      emails: 'text',
    });
  });
});

describe('contact cursor sort index coverage', () => {
  it('should expose only sortable fields with matching compound indexes', () => {
    const sortableFields = [...repo.cursorSortableFields] as string[];
    expect(sortableFields).toEqual([...CONTACT_SORTABLE_FIELDS]);

    // Every sortable field needs an index carrying the tenant prefix and the
    // `_id` tie-breaker, in either direction — without one, a legal API sort
    // becomes a blocking in-memory sort at million-contact cardinality.
    const indexKeys = ContactSchema.indexes().map(([keys]) => keys);
    for (const field of sortableFields) {
      const covered = indexKeys.some(
        (keys: any) =>
          Object.keys(keys).join(',') === `tenantId,${field},_id` &&
          keys[field] === keys._id,
      );
      expect([field, covered]).toEqual([field, true]);
    }
  });
});
