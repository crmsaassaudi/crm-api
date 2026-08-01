import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  AuthorizationFilterException,
  INDEXED_FILTER_FIELDS,
  IndexFilterUnsupportedException,
  mongoAuthorizationFilterToDsl,
} from './opensearch-filter';

describe('mongoAuthorizationFilterToDsl', () => {
  it('should preserve deny filters without widening access', () => {
    expect(
      mongoAuthorizationFilterToDsl({
        $nor: [{ statusId: { $in: ['private'] } }],
      }),
    ).toEqual({
      bool: {
        must_not: [{ terms: { statusId: ['private'] } }],
      },
    });
  });

  it('should refuse a deny predicate over a field the index does not store', () => {
    // `must_not` on an unmapped field matches every document, which would turn
    // this DENY into an ALLOW. Refusing is the only safe translation.
    expect(() =>
      mongoAuthorizationFilterToDsl({ $nor: [{ accountId: 'acc-1' }] }),
    ).toThrow(AuthorizationFilterException);
  });

  it('should refuse an unmapped field in a positive clause too', () => {
    expect(() => mongoAuthorizationFilterToDsl({ priority: 'HIGH' })).toThrow(
      /not part of the search index/,
    );
  });

  it('should fall back instead of full-scanning a flat_object subfield', () => {
    expect(() =>
      mongoAuthorizationFilterToDsl({ 'customFields.region': 'APAC' }),
    ).toThrow(/not safe for indexed authorization filtering/);
  });

  it('should reject a bare customFields prefix with no key', () => {
    expect(() =>
      mongoAuthorizationFilterToDsl({ 'customFields.': 'x' }),
    ).toThrow(AuthorizationFilterException);
  });

  it('should still reject operator injection in a field path', () => {
    expect(() => mongoAuthorizationFilterToDsl({ $where: '1' })).toThrow(
      AuthorizationFilterException,
    );
  });

  it('should not claim a field the indexer does not map', () => {
    // The allowlist is what keeps a DENY from becoming an ALLOW, so it must
    // never drift ahead of the mapping it mirrors.
    const definition = join(
      __dirname,
      '../../../../crm-opensearch/src/index/index-definition.ts',
    );
    if (!existsSync(definition)) return;

    const declared = readFileSync(definition, 'utf8')
      .split('export const INDEXED_FIELDS')[1]
      ?.split(']')[0];
    const mapped = new Set(
      [...(declared ?? '').matchAll(/"([a-zA-Z]+)"/g)].map((match) => match[1]),
    );
    expect(mapped.size).toBeGreaterThan(0);

    for (const field of INDEXED_FILTER_FIELDS) {
      expect([field, mapped.has(field)]).toEqual([field, true]);
    }
  });

  it('should render a date operand the way the index stores it', () => {
    // `String(new Date())` is "Thu Jul 31 2026 …", which matches no indexed
    // value — and a `must_not` that matches nothing matches everything, so a
    // DENY on a date-valued field silently became an ALLOW.
    const at = new Date('2026-07-31T12:00:00.000Z');
    expect(mongoAuthorizationFilterToDsl({ createdAt: { $gte: at } })).toEqual({
      range: { createdAt: { gte: '2026-07-31T12:00:00.000Z' } },
    });
  });

  it('should preserve a BSON ObjectId operand on keyword fields', () => {
    const value = {
      toHexString: () => '507F1F77BCF86CD799439011',
    };
    expect(mongoAuthorizationFilterToDsl({ ownerId: value })).toEqual({
      term: { ownerId: '507f1f77bcf86cd799439011' },
    });
  });

  it('should refuse a range over a flat_object custom field', () => {
    // OpenSearch has no numeric or date doc values under `flat_object`, so this
    // came back as a bare 400 that was indistinguishable from an outage.
    expect(() =>
      mongoAuthorizationFilterToDsl({ 'customFields.amount': { $gt: 1000 } }),
    ).toThrow(IndexFilterUnsupportedException);
  });

  it('should reject an invalid Date instead of emitting an invalid range', () => {
    expect(() =>
      mongoAuthorizationFilterToDsl({
        updatedAt: { $lt: new Date('not-a-date') },
      }),
    ).toThrow(/date operand must be valid/);
  });

  it('should refuse a non-scalar operand instead of stringifying it', () => {
    expect(() =>
      mongoAuthorizationFilterToDsl({ ownerId: { $ne: { nested: true } } }),
    ).toThrow(IndexFilterUnsupportedException);
  });

  it('should never compile an operand into a match-all', () => {
    // An empty or half-operator object used to enumerate to `{bool:{filter:[]}}`,
    // which matches every document: a widened ALLOW, or a DENY that denies
    // nothing, depending on which side of the clause it landed.
    for (const operand of [{}, { $ne: 'a', literal: 1 }]) {
      expect(() => mongoAuthorizationFilterToDsl({ ownerId: operand })).toThrow(
        IndexFilterUnsupportedException,
      );
    }
  });

  it('should classify an index limitation apart from a malformed predicate', () => {
    // Both are 403 by default; only the first may be answered by MongoDB.
    expect(() => mongoAuthorizationFilterToDsl({ priority: 'HIGH' })).toThrow(
      IndexFilterUnsupportedException,
    );
    try {
      mongoAuthorizationFilterToDsl({ $where: '1' });
      fail('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationFilterException);
      expect(error).not.toBeInstanceOf(IndexFilterUnsupportedException);
    }
  });

  it('should compile nested boolean structures over mapped fields', () => {
    expect(
      mongoAuthorizationFilterToDsl({
        $and: [
          { ownerId: 'u1' },
          { $or: [{ orgUnitId: 'o1' }, { tags: 'vip' }] },
        ],
      }),
    ).toEqual({
      bool: {
        filter: [
          { term: { ownerId: 'u1' } },
          {
            bool: {
              should: [
                { term: { orgUnitId: 'o1' } },
                { term: { tags: 'vip' } },
              ],
              minimum_should_match: 1,
            },
          },
        ],
      },
    });
  });

  it('should give empty set operators exact identities', () => {
    expect(mongoAuthorizationFilterToDsl({ ownerId: { $in: [] } })).toEqual({
      match_none: {},
    });
    expect(mongoAuthorizationFilterToDsl({ ownerId: { $nin: [] } })).toEqual({
      match_all: {},
    });
  });

  it('should reject malformed operator operands instead of coercing them', () => {
    for (const filter of [
      { ownerId: { $in: 'user-1' } },
      { ownerId: { $nin: 'user-1' } },
      { ownerId: { $exists: 'false' } },
      { updatedAt: { $gt: Number.POSITIVE_INFINITY } },
      { $or: [] },
      { $and: { ownerId: 'user-1' } },
    ]) {
      expect(() => mongoAuthorizationFilterToDsl(filter)).toThrow(
        AuthorizationFilterException,
      );
    }
  });

  it('should fall back for valid predicates whose BSON semantics would drift', () => {
    for (const filter of [
      { ownerId: { $ne: null } },
      { ownerId: { $in: [null, 'user-1'] } },
      { ownerId: { $nin: [null] } },
      { ownerId: /user/i },
      { ownerId: { $exists: true } },
      { ownerId: { $exists: false } },
      { updatedAt: { $lt: '2026-01-01' } },
      { statusId: { $gt: 'draft' } },
      { tags: { $gte: 'vip' } },
      { ownerId: 123 },
      { ownerId: true },
      { ownerId: { $in: ['user-1', 123] } },
      { updatedAt: '2026-01-01T00:00:00.000Z' },
    ]) {
      expect(() => mongoAuthorizationFilterToDsl(filter)).toThrow(
        IndexFilterUnsupportedException,
      );
    }
  });
});
