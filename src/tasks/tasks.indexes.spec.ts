import { readFileSync } from 'fs';
import { join } from 'path';
import { TaskSchema } from './infrastructure/persistence/document/entities/task.schema';

/**
 * Schema, migration and verifier must describe the same set of indexes.
 *
 * Three places have to agree, and nothing made them: `task.schema.ts` declares
 * indexes, `migrate:task-indexes` creates them (necessary because `autoIndex` is
 * false in production), and `verify-operational-indexes` asserts they exist. When
 * they drifted the failure was silent in the worst direction — the schema looked
 * authoritative while production had whatever some earlier deployment happened to
 * build, and `tasks` was not in the verifier at all, so nothing ever checked.
 *
 * This reads the two scripts as text rather than importing them: both connect to
 * Mongo at module scope, so importing would start a database client inside a unit
 * test.
 */
describe('task indexes stay in step across schema, migration and verifier', () => {
  const schemaIndexNames = TaskSchema.indexes()
    .map(([, options]) => (options as { name?: string })?.name)
    .filter((name): name is string => Boolean(name))
    .sort();

  const migrationSource = readFileSync(
    join(
      __dirname,
      '..',
      'scripts',
      'migrations',
      '2026-08-03-task-indexes.ts',
    ),
    'utf8',
  );

  const verifierSource = readFileSync(
    join(__dirname, '..', 'scripts', 'verify-operational-indexes.ts'),
    'utf8',
  );

  it('should name every schema index', () => {
    // An unnamed index gets a generated name, which neither the migration nor the
    // verifier can refer to — so it silently drops out of both.
    const unnamed = TaskSchema.indexes().filter(
      ([, options]) => !(options as { name?: string })?.name,
    );
    expect(unnamed).toEqual([]);
  });

  it('should declare the indexes the module queries need', () => {
    expect(schemaIndexNames).toEqual([
      'recurring_tasks_cron',
      'task_list_created',
      'task_list_default',
      'task_org_unit_scope',
      'task_owner_due',
      'task_purge_sweep',
      'task_related_lookup',
      'task_reminder_due',
      'task_status_due',
    ]);
  });

  it('should not key any index on a field the schema does not define', () => {
    // The set this replaced contained `{tenantId: 1, status: 1}`; the schema field
    // is `statusId`. That index stored a null entry for every document — write
    // cost, no read served — and looked plausible enough to survive review.
    const declaredPaths = new Set(Object.keys(TaskSchema.paths));
    for (const [key] of TaskSchema.indexes()) {
      for (const field of Object.keys(key)) {
        // Dotted paths address subdocuments of a Mixed field (`relatedTo._id`),
        // so compare on the root segment.
        const root = field.split('.')[0];
        expect(declaredPaths.has(root)).toBe(true);
      }
    }
  });

  it('should create every schema index in the migration', () => {
    for (const name of schemaIndexNames) {
      expect(migrationSource).toContain(`'${name}'`);
    }
  });

  it('should assert every schema index in the verifier', () => {
    for (const name of schemaIndexNames) {
      expect(verifierSource).toContain(`'${name}'`);
    }
  });
});
