import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { Schema } from 'mongoose';

/**
 * One rule, checked on every schema in the repository.
 *
 * This replaces `tasks.indexes.spec.ts`, which asserted five things about one
 * module. Three of those five only existed to keep three copies of the same
 * index list in agreement — schema, `migrate:task-indexes`, and the
 * `expectedIndexes` table in `verify-operational-indexes`. Those copies are
 * gone: `npm run db:setup` reconciles indexes from the schemas themselves, so
 * there is nothing left to drift against and nothing left to assert.
 *
 * A fourth — "every index must be named" — was also a consequence of the
 * copies: a generated name is one a migration script cannot refer to. With
 * `syncIndexes` doing the reconciliation, Mongoose and MongoDB agree on
 * generated names perfectly well. Requiring names across 312 declarations would
 * be a large sweep enforcing a rule nothing needs.
 *
 * The fifth rule is a real one and is kept, widened from `tasks` to everything:
 *
 *   An index may not key a field the schema does not define.
 *
 * That is not a style preference. The index this rule was written for keyed
 * `{tenantId: 1, status: 1}` on a collection whose field is `statusId`. Mongo
 * built it happily and stored a null entry for every document: it cost write
 * amplification on every insert and could never serve a read. It looked
 * plausible enough to survive review, and only surfaced when someone counted
 * indexes. `db:setup` will faithfully recreate such an index forever, because
 * from its point of view the schema asked for it.
 */

const SRC = join(__dirname, '..');

function schemaFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      schemaFiles(path, found);
    } else if (entry.endsWith('.schema.ts')) {
      found.push(path);
    }
  }
  return found;
}

/** Dotted paths address subdocuments (`relatedTo._id`); compare on the root. */
const rootOf = (field: string): string => field.split('.')[0];

/**
 * Paths a schema knows about without declaring them explicitly. `_id` is always
 * present; timestamps are added by the `{timestamps: true}` option, which is
 * applied at model build time and is therefore not in `schema.paths` here.
 */
const IMPLICIT_PATHS = new Set(['_id', '__v', 'createdAt', 'updatedAt', 'id']);

describe('schema index invariants', () => {
  const files = schemaFiles(SRC);
  const loaded: Array<{ file: string; name: string; schema: Schema }> = [];
  const failedToLoad: string[] = [];

  beforeAll(() => {
    for (const file of files) {
      try {
        // Synchronous by necessity: `beforeAll` collects every schema before
        // any assertion runs, and a dynamic `import()` would make the whole
        // walk async for no benefit — these modules have no side effects
        // beyond building Mongoose schemas.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const module_ = require(file) as Record<string, unknown>;
        for (const [name, value] of Object.entries(module_)) {
          if (value instanceof Schema) {
            loaded.push({ file, name, schema: value });
          }
        }
      } catch (error) {
        failedToLoad.push(
          `${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  });

  it('should find schemas to check', () => {
    // Without this the suite passes by checking nothing, which is the failure
    // mode a file-walking test is most prone to.
    expect(files.length).toBeGreaterThan(50);
    expect(loaded.length).toBeGreaterThan(50);
  });

  it('should be able to import every schema file', () => {
    // A schema that cannot be imported cannot be checked — and `db:setup` boots
    // the whole application, so it would fail there too.
    expect(failedToLoad).toEqual([]);
  });

  it('should not key any index on a field its schema does not define', () => {
    const offenders: string[] = [];

    for (const { file, name, schema } of loaded) {
      const declared = new Set(Object.keys(schema.paths));
      for (const [key] of schema.indexes()) {
        for (const field of Object.keys(key as Record<string, unknown>)) {
          const root = rootOf(field);
          if (declared.has(root) || IMPLICIT_PATHS.has(root)) continue;
          offenders.push(
            `${name} (${file.replace(SRC, 'src')}): index on "${field}" — no such path`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
