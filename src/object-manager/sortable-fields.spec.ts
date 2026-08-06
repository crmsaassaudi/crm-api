import { Schema } from 'mongoose';
import { SORTABLE_FIELDS, storagePathForSort } from './sortable-fields';
import { ConfigurableObject, STANDARD_FIELDS } from './object-registry';
import { ContactSchema } from '../contacts/infrastructure/persistence/document/entities/contact.schema';
import { AccountSchema } from '../accounts/infrastructure/persistence/document/entities/account.schema';
import { DealSchema } from '../deals/infrastructure/persistence/document/entities/deal.schema';
import { TicketSchema } from '../tickets/infrastructure/persistence/document/entities/ticket.schema';
import { TaskSchema } from '../tasks/infrastructure/persistence/document/entities/task.schema';

const SCHEMAS: Record<ConfigurableObject, Schema> = {
  Contact: ContactSchema,
  Account: AccountSchema,
  Deal: DealSchema,
  Ticket: TicketSchema,
  Task: TaskSchema,
};

/**
 * A sort the database cannot serve from an index is an in-memory sort, and past
 * Mongo's 32MB limit it fails outright rather than slowing down — for the
 * biggest tenant first. So every entry in SORTABLE_FIELDS must be backed by a
 * compound index `{ tenantId, <field>, _id }` whose `<field>` and `_id`
 * directions agree, which is what lets one index serve both sort directions and
 * keeps a page boundary from splitting two rows holding the same value.
 *
 * `dueDate` on Task is the documented exception: its index carries a status
 * prefix because the only query that sorts by it also filters on status.
 */
const hasBackingIndex = (schema: Schema, field: string): boolean =>
  schema.indexes().some(([definition]) => {
    const keys = definition as Record<string, number | string>;
    const names = Object.keys(keys);
    return (
      names[0] === 'tenantId' &&
      names.indexOf(field) > 0 &&
      names[names.length - 1] === '_id' &&
      keys[field] === keys._id
    );
  });

describe('SORTABLE_FIELDS', () => {
  const objects = Object.keys(SORTABLE_FIELDS) as ConfigurableObject[];

  it.each(objects)('%s lists no duplicates', (object) => {
    const fields = SORTABLE_FIELDS[object];
    expect(new Set(fields).size).toBe(fields.length);
  });

  it.each(objects)('%s sorts only by fields the registry knows', (object) => {
    const known = new Set(STANDARD_FIELDS[object].map((field) => field.key));
    const unknown = SORTABLE_FIELDS[object].filter(
      (field) => !known.has(field),
    );
    // A sortable field the registry has never heard of cannot be attached to a
    // column, so the UI would publish a sort nothing can trigger.
    expect(unknown).toEqual([]);
  });

  it.each(objects)('%s sorts only by indexed fields', (object) => {
    const schema = SCHEMAS[object];
    // Checked against the storage path, not the payload key: `Contact.name` is
    // composed by the mapper and sorts through `firstName`.
    const unbacked = SORTABLE_FIELDS[object].filter(
      (field) => !hasBackingIndex(schema, storagePathForSort(object, field)),
    );
    expect(unbacked).toEqual([]);
  });
});
