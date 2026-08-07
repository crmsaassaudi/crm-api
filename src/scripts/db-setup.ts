import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { AppModule } from '../app.module';

/**
 * Bring every collection's indexes in line with the schemas. One command.
 *
 * Why this exists at all
 * ---------------------
 * `autoIndex` is false in production (MongooseConfigService), so declaring an
 * index in a schema does NOT create it there. Something has to. That something
 * used to be eighteen hand-written `migrate:*` scripts plus a hand-written
 * `expectedIndexes` table in `verify-operational-indexes.ts` — a second copy of
 * the schema, joined to the first by a comment saying "keep in step with".
 * The table covered six of about a hundred and ten collections, which meant a
 * missing index on `contacts`, `deals`, `tickets` or `omni_conversations` was
 * not merely possible, it was undetectable: the schema was not evidence, and
 * nothing else was looking.
 *
 * `syncIndexes()` removes the second copy. Mongoose already knows the declared
 * indexes; asking it to reconcile them is strictly better than restating them
 * somewhere a human has to remember to update.
 *
 * What it does that the old scripts deliberately did not
 * -----------------------------------------------------
 * It DROPS indexes that no schema declares. The migrations avoided that on
 * purpose — dropping an index another deployment still relies on is how you
 * turn a slow query into an outage. That caution was correct while production
 * data existed. It does not, so drift can be removed rather than accumulated,
 * and "which indexes exist here" stops being a question with an unknown answer.
 *
 * Every drop is printed. Read the output; do not assume it is empty.
 *
 * Usage:
 *   npm run db:setup            # reconcile, print the diff
 *   npm run db:setup -- --check # fail if anything WOULD change (for CI)
 */

interface CollectionDiff {
  model: string;
  collection: string;
  created: string[];
  dropped: string[];
  error?: string;
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const connection = app.get<Connection>(getConnectionToken());

    // The database actually connected to, printed before anything else.
    // `DATABASE_NAME` overrides the database embedded in `DATABASE_URL`, and a
    // script that reads the wrong database reports a clean, empty, entirely
    // wrong result. `report:search-volume` was caught doing exactly that.
    console.log(
      `Database: ${connection.name} @ ${connection.host}:${connection.port}`,
    );
    console.log(
      checkOnly
        ? 'Mode: --check (no changes will be written)\n'
        : 'Mode: reconcile\n',
    );

    const modelNames = connection.modelNames().sort();
    const diffs: CollectionDiff[] = [];

    for (const modelName of modelNames) {
      const model = connection.model(modelName);
      const collection = model.collection.name;
      try {
        if (checkOnly) {
          const { toDrop, toCreate } = await plannedChanges(model);
          diffs.push({
            model: modelName,
            collection,
            created: toCreate,
            dropped: toDrop,
          });
          continue;
        }
        // Returns the names of the indexes it dropped. Creations are derived by
        // diffing, because `syncIndexes` does not report them.
        const before = await existingIndexNames(model);
        const dropped = await model.syncIndexes();
        const after = await existingIndexNames(model);
        diffs.push({
          model: modelName,
          collection,
          created: after.filter((name) => !before.includes(name)),
          dropped: Array.isArray(dropped) ? dropped : [],
        });
      } catch (error) {
        diffs.push({
          model: modelName,
          collection,
          created: [],
          dropped: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    report(diffs, checkOnly);

    const failed = diffs.filter((diff) => diff.error);
    if (failed.length > 0) process.exitCode = 1;
    if (checkOnly && diffs.some((d) => d.created.length || d.dropped.length)) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

const existingIndexNames = async (model: {
  collection: { indexes: () => Promise<Array<{ name?: string }>> };
}): Promise<string[]> => {
  try {
    const indexes = await model.collection.indexes();
    return indexes.map((index) => String(index.name));
  } catch {
    // Collection does not exist yet: nothing exists, so nothing to diff against.
    return [];
  }
};

/**
 * What `syncIndexes` would do, without doing it.
 *
 * `diffIndexes` is the same comparison `syncIndexes` runs internally, so
 * `--check` cannot disagree with the real run — which is the only property that
 * makes a CI gate worth having.
 */
const plannedChanges = async (model: any) => {
  const diff = await model.diffIndexes();
  return {
    toDrop: (diff?.toDrop ?? []).map((index: any) =>
      typeof index === 'string' ? index : String(index?.name ?? index),
    ),
    toCreate: (diff?.toCreate ?? []).map((index: any) => JSON.stringify(index)),
  };
};

function report(diffs: CollectionDiff[], checkOnly: boolean): void {
  const changed = diffs.filter(
    (diff) => diff.created.length || diff.dropped.length || diff.error,
  );

  if (changed.length === 0) {
    console.log(`${diffs.length} models checked. Nothing to do.`);
    return;
  }

  for (const diff of changed) {
    console.log(`\n${diff.collection}  (${diff.model})`);
    if (diff.error) {
      console.log(`  ERROR   ${diff.error}`);
      continue;
    }
    for (const name of diff.created) console.log(`  + ${name}`);
    // Printed with a marker that survives a skim. A dropped index is the only
    // irreversible thing this command does.
    for (const name of diff.dropped) console.log(`  - ${name}   (DROPPED)`);
  }

  const created = changed.reduce((sum, d) => sum + d.created.length, 0);
  const dropped = changed.reduce((sum, d) => sum + d.dropped.length, 0);
  const errors = changed.filter((d) => d.error).length;
  console.log(
    `\n${diffs.length} models checked · ${created} created · ${dropped} dropped · ${errors} errors`,
  );
  if (checkOnly && (created || dropped)) {
    console.log(
      '\n--check: indexes are out of sync with the schemas. Run `npm run db:setup`.',
    );
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
