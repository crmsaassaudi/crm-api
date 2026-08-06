import { Schema } from 'mongoose';
import { PLANNED_SORT_INDEXES } from './2026-08-06-list-sort-indexes';
import { DealSchema } from '../../deals/infrastructure/persistence/document/entities/deal.schema';
import { TicketSchema } from '../../tickets/infrastructure/persistence/document/entities/ticket.schema';
import { AccountSchema } from '../../accounts/infrastructure/persistence/document/entities/account.schema';

const SCHEMAS: Record<string, Schema> = {
  deals: DealSchema,
  tickets: TicketSchema,
  accounts: AccountSchema,
};

/**
 * Schema and migration have to describe the same indexes.
 *
 * `autoIndex` is false in production, so the schema declares and the migration
 * creates — two places, and nothing made them agree. When they drift the failure
 * is silent in the worst direction: the schema reads as authoritative while the
 * cluster has whatever some earlier deployment happened to build, and the first
 * symptom is a sort that dies on the largest tenant.
 */
describe('list sort index migration', () => {
  it.each(PLANNED_SORT_INDEXES)(
    '$collection.$name is declared in the schema with the same key',
    ({ collection, name, key }) => {
      const declared = SCHEMAS[collection]
        .indexes()
        .find(([, options]) => (options as { name?: string })?.name === name);

      expect(declared).toBeDefined();
      // Field ORDER is part of the identity: {a,b} and {b,a} serve different
      // queries, so a deep-equal on the object is not enough — compare entries.
      expect(Object.entries(declared![0] as Record<string, unknown>)).toEqual(
        Object.entries(key),
      );
    },
  );

  it('plans no duplicate collection/name pairs', () => {
    const labels = PLANNED_SORT_INDEXES.map((i) => `${i.collection}.${i.name}`);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('gives every planned index the _id tie-breaker in the field direction', () => {
    for (const { collection, name, key } of PLANNED_SORT_INDEXES) {
      const names = Object.keys(key);
      const field = names[1];
      expect([`${collection}.${name}`, names[0]]).toEqual([
        `${collection}.${name}`,
        'tenantId',
      ]);
      expect([`${collection}.${name}`, names[names.length - 1]]).toEqual([
        `${collection}.${name}`,
        '_id',
      ]);
      expect([`${collection}.${name}`, key[field] === key._id]).toEqual([
        `${collection}.${name}`,
        true,
      ]);
    }
  });
});
