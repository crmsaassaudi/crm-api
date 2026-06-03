/**
 * Render the 3 contact-import load-test CSV files (one per scenario), ready to
 * upload manually through the web import wizard.
 *
 *   npx ts-node src/scripts/load-test/render-test-files.ts
 *
 * Output (default → files/tmp/loadtest/):
 *   A_clean_100k.csv          100k rows, 0% duplicates      → KPI < 90s
 *   B_merge_100k_dup50.csv    100k rows, ~50% duplicates    → KPI < 180s
 *   C_concurrent_20k.csv      20k rows                      → upload in 5 tabs at once
 *
 * Tunables (env):
 *   A_ROWS=100000  B_ROWS=100000  B_DUP=50  C_ROWS=20000
 *   OUT_DIR=files/tmp/loadtest
 *   EMIT_CONCURRENT=1   also writes 5 DISTINCT files for scenario C
 *                       (C_concurrent_20k_1..5.csv) so a true concurrent run
 *                       inserts non-overlapping contacts.
 *
 * Every file uses the header the wizard auto-maps:
 *   First Name, Last Name, Email Address, Mobile Phone, Company
 */
import { statSync } from 'fs';
import { join } from 'path';
import { generateCsv } from '../generate-import-test-data';

const OUT_DIR = process.env.OUT_DIR ?? join(process.cwd(), 'files', 'tmp', 'loadtest');
const A_ROWS = Number(process.env.A_ROWS ?? 100_000);
const B_ROWS = Number(process.env.B_ROWS ?? 100_000);
const B_DUP = Number(process.env.B_DUP ?? 50);
const C_ROWS = Number(process.env.C_ROWS ?? 20_000);
const EMIT_CONCURRENT = process.env.EMIT_CONCURRENT === '1';

function mb(path: string): string {
  return (statSync(path).size / (1024 * 1024)).toFixed(1) + ' MB';
}

async function main() {
  const made: Array<{ file: string; rows: number; note: string }> = [];

  // Scenario A — clean insert (no duplicates).
  const a = join(OUT_DIR, `A_clean_${A_ROWS / 1000}k.csv`);
  await generateCsv({ count: A_ROWS, dupPct: 0, outFile: a, quiet: true });
  made.push({ file: a, rows: A_ROWS, note: 'no dedup; KPI < 90s' });

  // Scenario B — dedup heavy / merge (~50% duplicates).
  const b = join(OUT_DIR, `B_merge_${B_ROWS / 1000}k_dup${B_DUP}.csv`);
  await generateCsv({ count: B_ROWS, dupPct: B_DUP, outFile: b, quiet: true });
  made.push({
    file: b,
    rows: B_ROWS,
    note: `~${B_DUP}% duplicates; dedup emails+phones, merge; KPI < 180s`,
  });

  // Scenario C — concurrent. One file by default (upload in 5 tabs at once);
  // distinct offset so it never collides with A/B identities.
  const c = join(OUT_DIR, `C_concurrent_${C_ROWS / 1000}k.csv`);
  await generateCsv({
    count: C_ROWS,
    dupPct: 0,
    offset: 1_000_000,
    outFile: c,
    quiet: true,
  });
  made.push({
    file: c,
    rows: C_ROWS,
    note: 'upload simultaneously in 5 browser tabs (same tenant)',
  });

  if (EMIT_CONCURRENT) {
    for (let i = 1; i <= 5; i++) {
      const f = join(OUT_DIR, `C_concurrent_${C_ROWS / 1000}k_${i}.csv`);
      await generateCsv({
        count: C_ROWS,
        dupPct: 0,
        offset: 2_000_000 + i * C_ROWS, // distinct identities per file
        outFile: f,
        quiet: true,
      });
      made.push({ file: f, rows: C_ROWS, note: `concurrent shard ${i}/5` });
    }
  }

  process.stdout.write(`\nGenerated ${made.length} file(s) in ${OUT_DIR}:\n\n`);
  for (const m of made) {
    process.stdout.write(
      `  ${m.file}\n    ${m.rows.toLocaleString()} rows · ${mb(m.file)} · ${m.note}\n`,
    );
  }
  process.stdout.write(
    '\nUpload via the web wizard: Contacts → Import.\n' +
      '  • A: dedup OFF\n' +
      '  • B: dedup ON (emails+phones), policy = Merge\n' +
      '  • C: open 5 tabs, upload C_concurrent_*.csv in each at the same time\n',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
