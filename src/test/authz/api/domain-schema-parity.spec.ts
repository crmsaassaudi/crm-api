import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../../..');

/**
 * A field on a domain class must exist on its schema and in its mapper.
 *
 * Mongoose runs strict by default: a write to a field the schema does not declare is
 * dropped at the driver boundary, silently, with a 200 back to the caller. And
 * `BaseDocumentRepository.update` writes only what `toPersistence` emits, so a field the
 * mapper skips is dropped even when the schema has it. Between them, a field can be
 * declared on the domain model, accepted by a DTO, written by a service, logged as
 * written — and never reach the database.
 *
 * That is not hypothetical. Three features shipped in exactly that state:
 *
 *   - `tickets.dealId` — link-deal / unlink-deal / by-deal. Service method, route, ACL
 *     rule, and a log line reading `Ticket ↔ Deal linked`. No schema field, no mapper
 *     entry, and the list filter ignored `dealId` too, so `GET /tickets/by-deal/:dealId`
 *     answered with every ticket in the tenant and made the whole thing look like it
 *     worked.
 *   - `tickets.parentTicketId` — set-parent / remove-parent / children. Identical shape,
 *     identical outcome.
 *   - `accounts.nameKey` / `websiteDomain` / `taxIdKey` — derived on every PATCH and
 *     dropped by the mapper, so renaming a company left duplicate detection matching on
 *     its old name forever.
 *
 * Each was found by hand, one at a time. This is the check that would have found all
 * three at once.
 */

interface EntityPair {
  readonly name: string;
  readonly domain: string;
  readonly schema: string;
  readonly mapper: string;
}

const ENTITIES: readonly EntityPair[] = [
  {
    name: 'contact',
    domain: 'contacts/domain/contact.ts',
    schema:
      'contacts/infrastructure/persistence/document/entities/contact.schema.ts',
    mapper:
      'contacts/infrastructure/persistence/document/mappers/contact.mapper.ts',
  },
  {
    name: 'account',
    domain: 'accounts/domain/account.ts',
    schema:
      'accounts/infrastructure/persistence/document/entities/account.schema.ts',
    mapper:
      'accounts/infrastructure/persistence/document/mappers/account.mapper.ts',
  },
  {
    name: 'deal',
    domain: 'deals/domain/deal.ts',
    schema: 'deals/infrastructure/persistence/document/entities/deal.schema.ts',
    mapper: 'deals/infrastructure/persistence/document/mappers/deal.mapper.ts',
  },
  {
    name: 'ticket',
    domain: 'tickets/domain/ticket.ts',
    schema:
      'tickets/infrastructure/persistence/document/entities/ticket.schema.ts',
    mapper:
      'tickets/infrastructure/persistence/document/mappers/ticket.mapper.ts',
  },
  {
    name: 'task',
    domain: 'tasks/domain/task.ts',
    schema: 'tasks/infrastructure/persistence/document/entities/task.schema.ts',
    mapper: 'tasks/infrastructure/persistence/document/mappers/task.mapper.ts',
  },
];

/**
 * Domain fields that legitimately have no schema column. Every entry is one of two
 * categories, and anything outside them is the bug above.
 */
const NOT_PERSISTED: Record<string, string> = {
  // Mongo's own keys, renamed on the way out.
  id: '_id, stringified by the mapper',
  version: '__v, exposed for optimistic concurrency',

  // Populated relations: read-only projections of another collection, hydrated by
  // `.populate()` from the id field that IS persisted next to them.
  owner: 'populated from ownerId',
  createdBy: 'populated from createdById',
  updatedBy: 'populated from updatedById',
  accountType: 'populated from typeId',
  accountStatus: 'populated from statusId',
  dealStage: 'populated from stageId',
  pipelineName: 'populated from pipelineId',
  dealSource: 'populated from sourceId',
  ticketType: 'populated from typeId',
  ticketSource: 'populated from sourceId',
  ticketStatus: 'populated from statusId',
  ticketResolution: 'populated from resolutionId',
  taskStatus: 'populated from statusId',
  taskCategory: 'populated from categoryId',
  taskSource: 'populated from sourceId',
  group: 'populated from groupId',

  // Derived for the API response, never stored.
  name: 'computed from firstName + lastName',
};

/** Field declarations at class-body indentation: `  field?: Type;`. */
function declaredFields(source: string): Set<string> {
  const fields = new Set<string>();
  const pattern = /^ {2}(?:readonly\s+)?([a-zA-Z_][\w]*)\??\s*[:!]/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    fields.add(match[1]);
  }
  return fields;
}

const read = (relative: string): string =>
  fs.readFileSync(path.join(SRC, relative), 'utf8');

describe('domain / schema / mapper parity', () => {
  it('should find every entity trio', () => {
    for (const entity of ENTITIES) {
      for (const file of [entity.domain, entity.schema, entity.mapper]) {
        expect(fs.existsSync(path.join(SRC, file))).toBe(true);
      }
    }
    expect(ENTITIES.length).toBeGreaterThanOrEqual(5);
  });

  it.each(ENTITIES)(
    'every $name domain field should exist on the schema',
    (entity) => {
      const domainFields = declaredFields(read(entity.domain));
      const schemaFields = declaredFields(read(entity.schema));

      // A domain field with no schema column and no entry in NOT_PERSISTED is a write
      // that Mongoose will silently discard.
      const unexplained = [...domainFields].filter(
        (field) => !schemaFields.has(field) && !(field in NOT_PERSISTED),
      );

      expect({ entity: entity.name, unexplained }).toEqual({
        entity: entity.name,
        unexplained: [],
      });
    },
  );

  it.each(ENTITIES)(
    'every persisted $name field should round-trip through the mapper',
    (entity) => {
      const domainFields = declaredFields(read(entity.domain));
      const schemaFields = declaredFields(read(entity.schema));
      const mapper = read(entity.mapper);

      // Only fields the domain and schema agree on: those are the ones a PATCH can carry,
      // and the mapper is what decides whether the write survives.
      const persistable = [...domainFields].filter(
        (field) => schemaFields.has(field) && !(field in NOT_PERSISTED),
      );

      const missing = persistable.filter(
        (field) => !new RegExp(`\\b${field}\\b`).test(mapper),
      );

      expect({ entity: entity.name, missing }).toEqual({
        entity: entity.name,
        missing: [],
      });
    },
  );

  it('should keep the NOT_PERSISTED list from rotting into a blanket exemption', () => {
    // An entry that no domain class declares any more is an exemption with nothing to
    // exempt — and the next real field with that name inherits a free pass.
    const allDomainFields = new Set<string>();
    for (const entity of ENTITIES) {
      for (const field of declaredFields(read(entity.domain))) {
        allDomainFields.add(field);
      }
    }

    const stale = Object.keys(NOT_PERSISTED).filter(
      (field) => !allDomainFields.has(field),
    );
    expect(stale).toEqual([]);
  });
});
