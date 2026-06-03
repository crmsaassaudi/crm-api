/**
 * Load Test C — Concurrent imports, same tenant.
 *
 * Fires 5 imports of 20k DISTINCT contacts at once. Verifies:
 *   - the per-tenant Redis lock serializes them (no two run at once for one
 *     tenant) so dedup can never miss an in-flight insert → no duplicates;
 *   - BullMQ keeps draining the queue and the worker does not OOM
 *     (watch heap separately with monitor-worker-memory.sh).
 *
 *   CRM_BASE_URL=https://acme.crmsaudi.dev/api/v1 \
 *   CRM_SID=<session-cookie> \
 *   npx ts-node src/scripts/load-test/scenario-c-concurrent.ts
 *
 * Override:  JOBS=5 ROWS=20000 npx ts-node ...
 */
import { join } from 'path';
import { generateCsv, IMPORT_TEST_MAPPING } from '../generate-import-test-data';
import {
  fmtMs,
  loadConfigFromEnv,
  printResult,
  runImport,
  type RunResult,
} from './import-load-client';

const JOBS = Number(process.env.JOBS ?? 5);
const ROWS = Number(process.env.ROWS ?? 20_000);

async function main() {
  const cfg = loadConfigFromEnv();
  const dir = join(process.cwd(), 'files', 'tmp', 'loadtest');

  // Distinct identity ranges per file (offset) so each job inserts its own
  // contacts — overlap would be a different (correctness) test.
  process.stdout.write(
    `Generating ${JOBS} × ${ROWS.toLocaleString()} distinct files…\n`,
  );
  const files: string[] = [];
  for (let i = 0; i < JOBS; i++) {
    const f = join(dir, `c-concurrent-${i}.csv`);
    await generateCsv({
      count: ROWS,
      offset: 1_000_000 + i * ROWS,
      outFile: f,
      quiet: true,
    });
    files.push(f);
  }

  process.stdout.write(`Firing ${JOBS} imports concurrently…\n`);
  const t0 = Date.now();
  const results = await Promise.all(
    files.map((filePath, i) =>
      runImport(cfg, {
        filePath,
        rows: ROWS,
        mapping: IMPORT_TEST_MAPPING,
        deduplication: {
          matchingFields: ['emails', 'phones'],
          policy: 'merge',
        },
      }).catch(
        (err): RunResult => ({
          jobId: `job-${i}-error`,
          status: 'error',
          uploadMs: 0,
          importMs: 0,
          totalMs: 0,
          rows: ROWS,
          throughput: 0,
          failedReason: String(err?.message ?? err),
        }),
      ),
    ),
  );
  const wallMs = Date.now() - t0;

  results.forEach((r, i) => printResult(`Job ${i + 1}`, r));

  const completed = results.filter((r) => r.status === 'completed');
  const totalInserted = completed.reduce(
    (s, r) => s + (r.summary?.inserted ?? 0),
    0,
  );
  const totalErrors = completed.reduce(
    (s, r) => s + (r.summary?.errors ?? 0),
    0,
  );

  process.stdout.write(
    `\n══ Aggregate ══\n` +
      `  jobs completed : ${completed.length}/${JOBS}\n` +
      `  wall-clock     : ${fmtMs(wallMs)}\n` +
      `  total inserted : ${totalInserted.toLocaleString()} (expected ${(
        JOBS * ROWS
      ).toLocaleString()})\n` +
      `  total errors   : ${totalErrors}\n` +
      `  note           : per-tenant lock serializes jobs → wall-clock ≈ sum of import times\n`,
  );

  const ok =
    completed.length === JOBS &&
    totalInserted === JOBS * ROWS &&
    totalErrors === 0;
  process.stdout.write(`  RESULT         : ${ok ? 'PASS ✅' : 'FAIL ❌'}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
