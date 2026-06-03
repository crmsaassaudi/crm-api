/**
 * Load Test A — Clean Insert (no duplicates).
 *
 * 100k brand-new contacts, no dedup. Exercises the raw stream→bulkWrite path.
 * KPI: import completes in < 90s; worker heap stays < 500MB (watch separately
 *      with monitor-worker-memory.sh).
 *
 *   CRM_BASE_URL=https://acme.crmsaudi.dev/api/v1 \
 *   CRM_SID=<session-cookie> \
 *   npx ts-node src/scripts/load-test/scenario-a-clean-insert.ts
 *
 * Override size for a quick smoke run:  ROWS=10000 npx ts-node ...
 */
import { join } from 'path';
import { generateCsv, IMPORT_TEST_MAPPING } from '../generate-import-test-data';
import {
  loadConfigFromEnv,
  printResult,
  runImport,
} from './import-load-client';

const ROWS = Number(process.env.ROWS ?? 100_000);
const KPI_MS = Number(process.env.KPI_MS ?? 90_000);

async function main() {
  const cfg = loadConfigFromEnv();
  const file = join(
    process.cwd(),
    'files',
    'tmp',
    'loadtest',
    `a-clean-${ROWS}.csv`,
  );

  process.stdout.write(`Generating ${ROWS.toLocaleString()} clean rows…\n`);
  // Offset by a timestamp-free large constant per run is NOT used here; clean
  // insert assumes the target tenant has no matching contacts yet. Re-running
  // will create duplicates unless you clear the collection between runs.
  await generateCsv({ count: ROWS, outFile: file, quiet: true });

  process.stdout.write('Running import (no dedup)…\n');
  const result = await runImport(cfg, {
    filePath: file,
    rows: ROWS,
    mapping: IMPORT_TEST_MAPPING,
    onTick: (pct, processed) =>
      process.stdout.write(
        `\r  progress: ${processed.toLocaleString()} (${pct ?? '?'}%)   `,
      ),
  });

  printResult('Scenario A — Clean Insert', result, KPI_MS);
  process.exit(
    result.status === 'completed' && result.importMs <= KPI_MS ? 0 : 1,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
