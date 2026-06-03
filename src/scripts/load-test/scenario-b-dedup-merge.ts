/**
 * Load Test B — Dedup heavy (Merge).
 *
 * 100k rows with ~50% duplicating an earlier identity, merge policy on
 * emails + phones. Exercises the per-batch $in dedup query + merge update path.
 * KPI: import completes in < 180s.
 *
 *   CRM_BASE_URL=https://acme.crmsaudi.dev/api/v1 \
 *   CRM_SID=<session-cookie> \
 *   npx ts-node src/scripts/load-test/scenario-b-dedup-merge.ts
 *
 * Override:  ROWS=20000 DUP=50 KPI_MS=60000 npx ts-node ...
 */
import { join } from 'path';
import { generateCsv, IMPORT_TEST_MAPPING } from '../generate-import-test-data';
import {
  loadConfigFromEnv,
  printResult,
  runImport,
} from './import-load-client';

const ROWS = Number(process.env.ROWS ?? 100_000);
const DUP = Number(process.env.DUP ?? 50);
const KPI_MS = Number(process.env.KPI_MS ?? 180_000);

async function main() {
  const cfg = loadConfigFromEnv();
  const file = join(
    process.cwd(),
    'files',
    'tmp',
    'loadtest',
    `b-merge-${ROWS}-dup${DUP}.csv`,
  );

  process.stdout.write(
    `Generating ${ROWS.toLocaleString()} rows (~${DUP}% duplicates)…\n`,
  );
  await generateCsv({ count: ROWS, dupPct: DUP, outFile: file, quiet: true });

  process.stdout.write('Running import (dedup emails+phones, merge)…\n');
  const result = await runImport(cfg, {
    filePath: file,
    rows: ROWS,
    mapping: IMPORT_TEST_MAPPING,
    deduplication: { matchingFields: ['emails', 'phones'], policy: 'merge' },
    onTick: (pct, processed) =>
      process.stdout.write(
        `\r  progress: ${processed.toLocaleString()} (${pct ?? '?'}%)   `,
      ),
  });

  printResult('Scenario B — Dedup Merge', result, KPI_MS);
  process.exit(
    result.status === 'completed' && result.importMs <= KPI_MS ? 0 : 1,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
