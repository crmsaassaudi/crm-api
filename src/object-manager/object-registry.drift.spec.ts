import { Schema } from 'mongoose';
import { AccountSchema } from '../accounts/infrastructure/persistence/document/entities/account.schema';
import { ContactSchema } from '../contacts/infrastructure/persistence/document/entities/contact.schema';
import { DealSchema } from '../deals/infrastructure/persistence/document/entities/deal.schema';
import { TaskSchema } from '../tasks/infrastructure/persistence/document/entities/task.schema';
import { TicketSchema } from '../tickets/infrastructure/persistence/document/entities/ticket.schema';
import { isFieldType } from '../custom-fields/field-type';
import {
  CONFIGURABLE_OBJECTS,
  ConfigurableObject,
  STANDARD_FIELDS,
  isFieldMaskable,
  isFieldRequirable,
} from './object-registry';
import { ObjectRegistryService, columnKeyOf } from './object-registry.service';

/**
 * The guardrail the field catalog never had.
 *
 * Four production bugs came from the same root cause: the catalog named a field
 * `amount`/`type`/`employees`/`subject` while the document stored it as
 * `value`/`typeId`/`numberOfEmployees`/`title`. Every one of them was silent —
 * masking that never fired, a required flag that made creation impossible, a
 * column that could not be re-added.
 *
 * A registry entry whose `key` is not a real schema path now fails here. That is
 * the entire point of this file: the drift becomes a red test instead of a
 * setting that saves and does nothing.
 */

const SCHEMAS: Record<ConfigurableObject, Schema> = {
  Contact: ContactSchema,
  Account: AccountSchema,
  Deal: DealSchema,
  Ticket: TicketSchema,
  Task: TaskSchema,
};

/** Paths a mapper synthesises rather than reads from the document. */
const schemaHasPath = (schema: Schema, path: string): boolean =>
  Boolean(schema.path(path)) || Boolean(schema.paths[path]);

describe('object registry ↔ persistence drift', () => {
  describe.each(CONFIGURABLE_OBJECTS)('%s', (object) => {
    const fields = STANDARD_FIELDS[object];
    const schema = SCHEMAS[object];

    it('should declare at least one field', () => {
      expect(fields.length).toBeGreaterThan(0);
    });

    it.each(fields.filter((field) => !field.derived).map((f) => [f.key, f]))(
      'field key "%s" exists on the Mongoose schema',
      (_key, field) => {
        expect(schemaHasPath(schema, field.key)).toBe(true);
      },
    );

    it('should mark every field it cannot find on the schema as derived', () => {
      const missing = fields
        .filter((field) => !schemaHasPath(schema, field.key))
        .filter((field) => !field.derived)
        .map((field) => field.key);
      expect(missing).toEqual([]);
    });

    it('should have no duplicate field keys', () => {
      const keys = fields.map((field) => field.key);
      expect(keys).toEqual([...new Set(keys)]);
    });

    it('should have no duplicate column keys', () => {
      const columns = fields.map(columnKeyOf);
      expect(columns).toEqual([...new Set(columns)]);
    });

    it('should have no ambiguous legacy alias', () => {
      // Two fields claiming the same old name would make migration a coin flip.
      const aliases = fields.flatMap((field) => field.legacyAliases ?? []);
      expect(aliases).toEqual([...new Set(aliases)]);
    });

    it('should mirror only real schema paths', () => {
      const missing = fields
        .flatMap((field) => field.mirroredKeys ?? [])
        .filter((key) => !schemaHasPath(schema, key));
      expect(missing).toEqual([]);
    });

    it('should use only known field types', () => {
      const unknown = fields
        .filter((field) => !isFieldType(field.type))
        .map((field) => field.type);
      expect(unknown).toEqual([]);
    });

    it('should never mark a read-only field as requirable', () => {
      const contradictory = fields
        .filter((field) => field.readOnly && isFieldRequirable(field))
        .map((field) => field.key);
      expect(contradictory).toEqual([]);
    });

    it('should never offer masking on a field whose stored value is not string-shaped', () => {
      // A masking rule on a NUMBER or DATE saves, renders as active, and does
      // nothing — FieldPolicyInterceptor only rewrites strings and string arrays.
      const nonString = fields
        .filter(isFieldMaskable)
        .filter(
          (field) =>
            ![
              'TEXT',
              'TEXTAREA',
              'EMAIL',
              'PHONE',
              'URL',
              'ENCRYPTED',
            ].includes(field.type) &&
            ![
              'SINGLE_SELECT',
              'RADIO',
              'MULTI_SELECT',
              'CHECKBOX_GROUP',
              'USER_REFERENCE',
              'TEAM_REFERENCE',
              'RELATION',
              'MULTI_LOOKUP',
              'FILE_UPLOAD',
            ].includes(field.type),
        )
        .map((field) => field.key);
      expect(nonString).toEqual([]);
    });
  });

  describe('regressions this registry exists to prevent', () => {
    const service = new ObjectRegistryService();

    it.each([
      ['Deal', 'amount', 'value'],
      ['Ticket', 'type', 'typeId'],
      ['Ticket', 'status', 'statusId'],
      ['Task', 'subject', 'title'],
      ['Task', 'assignee', 'ownerId'],
      ['Account', 'employees', 'numberOfEmployees'],
      ['Contact', 'owner', 'ownerId'],
      ['Contact', 'lifecycleStage', 'lifecycleStageId'],
    ] as Array<[ConfigurableObject, string, string]>)(
      '%s: legacy key "%s" resolves to payload key "%s"',
      (object, legacyKey, payloadKey) => {
        expect(service.resolveFieldKey(object, legacyKey)?.key).toBe(
          payloadKey,
        );
      },
    );

    it('should Contact.fullName is a known column so a removed list-view column can be restored', () => {
      expect(service.fieldByColumn('Contact', 'fullName')?.key).toBe('name');
    });

    it('should refuse isRequired on a server-owned field', () => {
      // The Ticket `type` bug in its general form: a required flag on a field the
      // client cannot set is a 422 nobody can clear.
      expect(service.requirableFieldKeys('Contact').has('score')).toBe(false);
      expect(service.requirableFieldKeys('Ticket').has('ticketNumber')).toBe(
        false,
      );
      expect(service.requirableFieldKeys('Contact').has('createdAt')).toBe(
        false,
      );
    });

    it('should reject an unknown object instead of silently falling back to Contact', () => {
      // getStandardFields() used to `default:` to the Lead catalog, so a typo in
      // the URL rendered Contact fields under another object's name.
      expect(() => service.assertObject('Lead')).toThrow(/Unknown object/);
      expect(() => service.assertObject('Invoice')).toThrow(/Unknown object/);
    });
  });
});
