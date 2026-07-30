import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ContactMetricsRollupService } from '../reports/contact/rollup/contact-metrics-rollup.service';

/**
 * Backfill `contact_daily_metrics` for a date range.
 *
 * The growth-trend report consults the rollup first and falls back to the live
 * aggregation whenever the requested range extends past what has been computed. So
 * until this has run, the rollup is inert — correct, just not helping. Running it is
 * what turns the optimisation on.
 *
 * The freshness check is what makes that safe: an un-backfilled deployment reports
 * from the live query rather than reporting zeros for days it has no rows for.
 *
 * Usage:
 *   npm run backfill:contact-metrics -- --from=2026-01-01 --to=2026-07-28
 *   npm run backfill:contact-metrics -- --days=90
 *
 * Idempotent: each day is upserted on a unique bucket key with `$set`, never `$inc`,
 * so re-running recomputes rather than doubles. Safe to interrupt and resume.
 *
 * Uses the same `REPORT_ROLLUP_TIMEZONE` as the nightly job (default UTC). Changing
 * that env var after a backfill does NOT corrupt anything — the timezone is stored on
 * every row and the reader requires an exact match, so old rows simply stop being
 * used until they are recomputed under the new zone.
 */

interface Args {
  from?: string;
  to?: string;
  days?: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (key: string) => {
    const match = argv.find((a) => a.startsWith(`--${key}=`));
    return match ? match.slice(key.length + 3) : undefined;
  };
  const days = get('days');
  return {
    from: get('from'),
    to: get('to'),
    days: days ? Number(days) : undefined,
  };
}

function resolveRange(args: Args): { from: string; to: string } {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  if (args.from) {
    return { from: args.from, to: args.to ?? yesterday };
  }
  if (args.days && Number.isFinite(args.days) && args.days > 0) {
    const start = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000);
    return { from: start.toISOString().slice(0, 10), to: yesterday };
  }
  // Default to 90 days: enough to serve the dashboard's usual ranges without
  // committing an operator to a full-history pass they did not ask for.
  const start = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  return { from: start.toISOString().slice(0, 10), to: yesterday };
}

async function run(): Promise<void> {
  const { from, to } = resolveRange(parseArgs());
  if (from > to) {
    console.error(`--from (${from}) is after --to (${to}).`);
    process.exit(1);
  }

  const timezone = process.env.REPORT_ROLLUP_TIMEZONE?.trim() || 'UTC';
  console.log(
    `Backfilling contact_daily_metrics ${from} → ${to} in ${timezone}…`,
  );

  // The full app context, so the rollup service gets its real models and lock.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const rollup = app.get(ContactMetricsRollupService, { strict: false });
    const result = await rollup.backfill(from, to);
    console.log(
      `Done: ${result.buckets} bucket(s) across ${result.days} day(s).`,
    );
    console.log(
      '\nThe growth-trend report will now serve unfiltered and owner-scoped\n' +
        'requests from the rollup. Filtered requests (source, stage, channel, VIP)\n' +
        'and anything past the last computed day still use the live query.\n' +
        'Set REPORT_ROLLUP_ENABLED=false to take the rollup out of the read path.',
    );
  } finally {
    await app.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
