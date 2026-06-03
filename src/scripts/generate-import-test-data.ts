/**
 * Generate CSV fixtures for contact-import load testing.
 *
 * Usage:
 *   ts-node src/scripts/generate-import-test-data.ts <count> [outFile] [--dup=<pct>]
 *   ts-node src/scripts/generate-import-test-data.ts smoke   # 10k
 *   ts-node src/scripts/generate-import-test-data.ts load    # 100k
 *   ts-node src/scripts/generate-import-test-data.ts stress  # 500k
 *
 * --dup=50 makes ~50% of rows reuse an earlier email/phone (dedup stress).
 *
 * Streams rows to disk so even a 1M-row file never sits in memory.
 */
import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { once } from 'events';
import { dirname, join } from 'path';

const PRESETS: Record<string, number> = {
  smoke: 10_000,
  load: 100_000,
  stress: 500_000,
};

const FIRST = [
  'An',
  'Binh',
  'Chi',
  'Dung',
  'Hoa',
  'Khanh',
  'Linh',
  'Minh',
  'Nam',
  'Phuc',
];
const LAST = [
  'Nguyen',
  'Tran',
  'Le',
  'Pham',
  'Hoang',
  'Vu',
  'Dang',
  'Bui',
  'Do',
  'Ngo',
];
const COMPANIES = [
  'Acme',
  'Globex',
  'Initech',
  'Umbrella',
  'Soylent',
  'Stark',
  'Wayne',
];

export interface GenerateCsvOptions {
  /** Number of data rows (excluding header). */
  count: number;
  /** Approx percentage of rows that reuse an earlier identity (0–100). */
  dupPct?: number;
  /** Output CSV path. */
  outFile: string;
  /** Identity offset so multiple files produce DISTINCT contacts. */
  offset?: number;
  /** Suppress progress logging (useful when called from a load runner). */
  quiet?: boolean;
}

export const IMPORT_TEST_HEADER =
  'First Name,Last Name,Email Address,Mobile Phone,Company';

/** Mapping the generated header → Contact fields (for import payloads). */
export const IMPORT_TEST_MAPPING: Record<string, string> = {
  'First Name': 'firstName',
  'Last Name': 'lastName',
  'Email Address': 'emails',
  'Mobile Phone': 'phones',
  Company: 'companyName',
};

/**
 * Stream a contact CSV to disk. Reusable from load-test scripts as well as the
 * CLI below. Memory stays flat regardless of `count` (rows are streamed).
 */
export async function generateCsv(
  opts: GenerateCsvOptions,
): Promise<{ written: number; outFile: string }> {
  const { count, outFile } = opts;
  const dupPct = opts.dupPct ?? 0;
  const offset = opts.offset ?? 0;

  await mkdir(dirname(outFile), { recursive: true });
  const out = createWriteStream(outFile, { encoding: 'utf8' });
  const write = async (chunk: string) => {
    if (!out.write(chunk)) await once(out, 'drain');
  };

  await write(`${IMPORT_TEST_HEADER}\n`);

  const pick = <T>(arr: T[], i: number) => arr[i % arr.length];
  let written = 0;
  for (let i = 0; i < count; i++) {
    // For dup rows, reuse an identity from earlier in the same file.
    const isDup = dupPct > 0 && i > 100 && i % 100 < dupPct;
    const id = (isDup ? i - 50 : i) + offset;
    const first = pick(FIRST, id);
    const last = pick(LAST, Math.floor(id / FIRST.length));
    const email = `user${id}@example.com`;
    const phone = `+849${String(10_000_000 + (id % 90_000_000)).padStart(8, '0')}`;
    const company = pick(COMPANIES, id);
    await write(`${first},${last},${email},${phone},${company}\n`);
    written++;
    if (!opts.quiet && written % 50_000 === 0) {
      process.stdout.write(`  …${written.toLocaleString()} rows\n`);
    }
  }

  out.end();
  await once(out, 'finish');
  return { written, outFile };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const first = args[0] ?? 'smoke';
  const count = PRESETS[first] ?? Number(first);
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error(`Invalid count/preset: ${first}`);
  }
  const dupArg = args.find((a) => a.startsWith('--dup='));
  const dupPct = dupArg ? Number(dupArg.split('=')[1]) : 0;
  const offsetArg = args.find((a) => a.startsWith('--offset='));
  const offset = offsetArg ? Number(offsetArg.split('=')[1]) : 0;
  const outFile =
    args.find((a) => !a.startsWith('--') && a !== first) ??
    join(process.cwd(), 'files', 'tmp', `import-test-${count}.csv`);
  return { count, dupPct, outFile, offset };
}

async function main() {
  const { count, dupPct, outFile, offset } = parseArgs();
  const { written } = await generateCsv({ count, dupPct, outFile, offset });
  process.stdout.write(
    `Wrote ${written.toLocaleString()} rows (dup≈${dupPct}%, offset=${offset}) → ${outFile}\n`,
  );
}

// Only run the CLI when executed directly, not when imported as a module.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
