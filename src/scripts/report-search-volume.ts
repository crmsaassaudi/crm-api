/**
 * Report the data volume every search decision depends on.
 *
 * Why this script exists before any of the search work it informs: the audit
 * that produced that work was written against targets of 1M/10M/100M contacts
 * and 1B messages, which came from the brief — not from this deployment. Sizing
 * an OpenSearch cluster, or rewriting a `$regex` list query, is only justified
 * once the largest tenant is actually large. A tenant with 40,000 deals is
 * served perfectly well by the plan we already have.
 *
 * So this prints, per collection: total documents, the largest tenants, and the
 * average document size — plus an `explain` of the four list-search queries the
 * audit flagged, run against the largest tenant, so the cost is measured rather
 * than asserted.
 *
 * Read-only. Runs against a secondary where the connection allows it, so it can
 * be run on production without competing with live traffic.
 *
 *   npm run report:search-volume
 *   npm run report:search-volume -- --json > volume.json
 *   npm run report:search-volume -- --top 20
 */
import 'dotenv/config';
import { MongoClient, ReadPreference } from 'mongodb';

interface TenantSlice {
  tenantId: string;
  count: number;
}

interface CollectionReport {
  collection: string;
  documents: number;
  storageBytes: number;
  avgObjSize: number;
  indexCount: number;
  indexBytes: number;
  topTenants: TenantSlice[];
  /** Documents held by the single largest tenant. */
  largestTenantCount: number;
  /** Share of the collection owned by the largest tenant, 0..1. */
  largestTenantShare: number;
  error?: string;
}

interface ExplainReport {
  label: string;
  collection: string;
  stage: string;
  indexName?: string;
  keysExamined: number;
  docsExamined: number;
  returned: number;
  executionMs: number;
  /**
   * Documents read per document returned. The number that says whether a query
   * is a lookup or a scan; anything in the thousands is a scan wearing a filter.
   */
  examinedPerReturned: number | null;
  error?: string;
}

const COLLECTIONS = [
  'contacts',
  'accounts',
  'deals',
  'tickets',
  'tasks',
  'omni_conversations',
  'omni_messages',
  'activity_logs',
  'audit_logs',
  'contact_identities',
  'automation_workflows',
] as const;

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const TOP_TENANTS = Number(argValue('top') ?? 10);
const AS_JSON = hasFlag('json');

const bytes = (value: number): string => {
  if (!Number.isFinite(value)) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

async function reportCollection(
  db: import('mongodb').Db,
  collection: string,
): Promise<CollectionReport> {
  const base: CollectionReport = {
    collection,
    documents: 0,
    storageBytes: 0,
    avgObjSize: 0,
    indexCount: 0,
    indexBytes: 0,
    topTenants: [],
    largestTenantCount: 0,
    largestTenantShare: 0,
  };
  try {
    const stats = (await db.command({ collStats: collection })) as any;
    base.documents = Number(stats.count ?? 0);
    base.storageBytes = Number(stats.size ?? 0);
    base.avgObjSize = Number(stats.avgObjSize ?? 0);
    base.indexCount = Object.keys(stats.indexSizes ?? {}).length;
    base.indexBytes = Number(stats.totalIndexSize ?? 0);
  } catch (error: any) {
    // A collection that does not exist yet is information, not a failure: it
    // means the module has never been used in this deployment.
    return {
      ...base,
      error: error?.codeName ?? error?.message ?? 'unavailable',
    };
  }

  if (base.documents === 0) return base;

  try {
    // $group over the whole collection is the honest way to find the largest
    // tenant, and on a big collection it is not cheap — hence the secondary read
    // preference and `allowDiskUse`. This is a one-off diagnostic, not a hot path.
    const slices = await db
      .collection(collection)
      .aggregate<{ _id: unknown; count: number }>(
        [
          { $group: { _id: '$tenantId', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: Math.max(1, TOP_TENANTS) },
        ],
        {
          allowDiskUse: true,
          readPreference: ReadPreference.SECONDARY_PREFERRED,
        },
      )
      .toArray();
    base.topTenants = slices.map((slice) => ({
      tenantId: String(slice._id ?? 'null'),
      count: slice.count,
    }));
    base.largestTenantCount = base.topTenants[0]?.count ?? 0;
    base.largestTenantShare = base.documents
      ? base.largestTenantCount / base.documents
      : 0;
  } catch (error: any) {
    base.error = `tenant breakdown failed: ${error?.message}`;
  }

  return base;
}

/**
 * The four list-search queries the audit called out, shaped exactly as the
 * repositories build them — an unanchored case-insensitive `$regex` over an
 * `$or` of fields with no text index.
 */
const searchProbes = (
  tenantId: unknown,
  term: string,
): Array<{
  label: string;
  collection: string;
  filter: Record<string, unknown>;
}> => {
  const expression = { $regex: term, $options: 'i' };
  return [
    {
      label: 'deals list search ($regex $or)',
      collection: 'deals',
      filter: {
        tenantId,
        deletedAt: null,
        $or: [
          { title: expression },
          { name: expression },
          { accountName: expression },
        ],
      },
    },
    {
      label: 'tickets list search ($regex $or)',
      collection: 'tickets',
      filter: {
        tenantId,
        deletedAt: null,
        $or: [
          { subject: expression },
          { ticketNumber: expression },
          { description: expression },
        ],
      },
    },
    {
      label: 'tasks list search ($regex $or)',
      collection: 'tasks',
      filter: {
        tenantId,
        deletedAt: null,
        $or: [{ title: expression }, { description: expression }],
      },
    },
    {
      label: 'accounts list search ($regex $or)',
      collection: 'accounts',
      filter: {
        tenantId,
        deletedAt: null,
        $or: [{ name: expression }, { industry: expression }],
      },
    },
  ];
};

async function explainProbe(
  db: import('mongodb').Db,
  probe: { label: string; collection: string; filter: Record<string, unknown> },
): Promise<ExplainReport> {
  const report: ExplainReport = {
    label: probe.label,
    collection: probe.collection,
    stage: 'unknown',
    keysExamined: 0,
    docsExamined: 0,
    returned: 0,
    executionMs: 0,
    examinedPerReturned: null,
  };
  try {
    const explained = (await db
      .collection(probe.collection)
      .find(probe.filter, {
        readPreference: ReadPreference.SECONDARY_PREFERRED,
      })
      .sort({ createdAt: -1 })
      .limit(25)
      .explain('executionStats')) as any;

    const stats = explained.executionStats ?? {};
    const winning = explained.queryPlanner?.winningPlan ?? {};
    report.keysExamined = Number(stats.totalKeysExamined ?? 0);
    report.docsExamined = Number(stats.totalDocsExamined ?? 0);
    report.returned = Number(stats.nReturned ?? 0);
    report.executionMs = Number(stats.executionTimeMillis ?? 0);
    report.stage = findStage(winning);
    report.indexName = findIndexName(winning);
    report.examinedPerReturned = report.returned
      ? Number((report.docsExamined / report.returned).toFixed(1))
      : null;
  } catch (error: any) {
    report.error = error?.message ?? 'explain failed';
  }
  return report;
}

/** Walk a winning plan to the leaf access stage (COLLSCAN / IXSCAN / …). */
function findStage(plan: any): string {
  let node = plan?.queryPlan ?? plan;
  const seen: string[] = [];
  while (node) {
    if (node.stage) seen.push(node.stage);
    node = node.inputStage ?? node.inputStages?.[0];
  }
  return seen.length ? seen.join(' → ') : 'unknown';
}

function findIndexName(plan: any): string | undefined {
  let node = plan?.queryPlan ?? plan;
  while (node) {
    if (node.indexName) return node.indexName;
    node = node.inputStage ?? node.inputStages?.[0];
  }
  return undefined;
}

function printHuman(
  reports: CollectionReport[],
  explains: ExplainReport[],
  probeTenant: string | null,
  databaseName: string,
): void {
  // Named explicitly: which database these numbers came from is the first thing
  // to check when they look surprising, and DATABASE_NAME can silently point
  // this somewhere other than DATABASE_URL suggests.
  console.log(
    `\n═══ Data volume by collection — database "${databaseName}" ═══\n`,
  );
  const header = [
    'collection'.padEnd(22),
    'docs'.padStart(12),
    'storage'.padStart(10),
    'indexes'.padStart(9),
    'avg doc'.padStart(9),
    'largest tenant'.padStart(16),
    'share'.padStart(7),
  ].join(' ');
  console.log(header);
  console.log('─'.repeat(header.length));
  for (const report of reports) {
    if (report.error && report.documents === 0) {
      console.log(
        `${report.collection.padEnd(22)} ${'—'.padStart(12)}   (${report.error})`,
      );
      continue;
    }
    console.log(
      [
        report.collection.padEnd(22),
        report.documents.toLocaleString().padStart(12),
        bytes(report.storageBytes).padStart(10),
        bytes(report.indexBytes).padStart(9),
        bytes(report.avgObjSize).padStart(9),
        report.largestTenantCount.toLocaleString().padStart(16),
        `${(report.largestTenantShare * 100).toFixed(1)}%`.padStart(7),
      ].join(' '),
    );
  }

  console.log('\n═══ Thresholds from the remediation plan ═══\n');
  const largestModule = reports
    .filter((report) =>
      ['contacts', 'accounts', 'deals', 'tickets', 'tasks'].includes(
        report.collection,
      ),
    )
    .reduce(
      (worst, report) =>
        report.largestTenantCount > worst.largestTenantCount ? report : worst,
      { collection: 'none', largestTenantCount: 0 } as CollectionReport,
    );
  const messages =
    reports.find((report) => report.collection === 'omni_messages')
      ?.documents ?? 0;
  const indexable = reports
    .filter((report) =>
      ['contacts', 'accounts', 'deals', 'tickets', 'tasks'].includes(
        report.collection,
      ),
    )
    .reduce((sum, report) => sum + report.documents, 0);
  const maxShare = Math.max(
    0,
    ...reports.map((report) => report.largestTenantShare),
  );

  const verdict = (crossed: boolean): string =>
    crossed ? 'CROSSED' : 'not yet';
  console.log(
    `  list view → OpenSearch  (largest tenant > 300,000 in one module): ${verdict(
      largestModule.largestTenantCount > 300_000,
    )} — worst is ${largestModule.collection} at ${largestModule.largestTenantCount.toLocaleString()}`,
  );
  console.log(
    `  reindex slicing         (indexable documents > 5,000,000):        ${verdict(
      indexable > 5_000_000,
    )} — ${indexable.toLocaleString()}`,
  );
  console.log(
    `  tenant-wide message search (omni_messages > 50,000,000):          ${verdict(
      messages > 50_000_000,
    )} — ${messages.toLocaleString()}`,
  );
  console.log(
    `  _routing by tenant      (one tenant > 30% of a collection):       ${verdict(
      maxShare > 0.3,
    )} — max share ${(maxShare * 100).toFixed(1)}%`,
  );

  if (!explains.length) {
    console.log('\n(no tenant had enough data to explain the search probes)\n');
    return;
  }
  console.log(
    `\n═══ Query plans for the flagged list searches (tenant ${probeTenant}) ═══\n`,
  );
  for (const explain of explains) {
    if (explain.error) {
      console.log(`  ${explain.label}: ${explain.error}`);
      continue;
    }
    console.log(`  ${explain.label}`);
    console.log(
      `    plan: ${explain.stage}${
        explain.indexName ? ` (index: ${explain.indexName})` : ''
      }`,
    );
    console.log(
      `    docsExamined=${explain.docsExamined.toLocaleString()} keysExamined=${explain.keysExamined.toLocaleString()} returned=${explain.returned} in ${explain.executionMs}ms` +
        (explain.examinedPerReturned !== null
          ? ` → ${explain.examinedPerReturned} docs read per row returned`
          : ''),
    );
  }
  console.log(
    '\n  Reading this: a plan whose leaf is COLLSCAN, or whose docs-read-per-row is\n' +
      '  in the thousands, is a scan. At small volume that is still fast and needs no\n' +
      '  action — the number to watch is docsExamined, because it grows with the\n' +
      '  tenant while the latency only becomes visible later.\n',
  );
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const client = new MongoClient(url, {
    readPreference: ReadPreference.SECONDARY_PREFERRED,
  });
  await client.connect();
  try {
    const db = client.db(process.env.DATABASE_NAME || undefined);

    const reports: CollectionReport[] = [];
    for (const collection of COLLECTIONS) {
      reports.push(await reportCollection(db, collection));
    }

    // `DATABASE_NAME` overrides the database named in `DATABASE_URL`, and it is
    // loaded from `.env` — so pointing the URL at one database while `.env`
    // names another reads the wrong one and reports zeros everywhere. That is
    // the worst possible failure for a measurement instrument: an operator sees
    // "no data", concludes there is nothing to size for, and skips all the work
    // these numbers exist to drive. A live CRM always has records in at least
    // one of these collections, so an all-zero read is a misconfiguration, not
    // an answer.
    const totalDocuments = reports.reduce(
      (sum, report) => sum + report.documents,
      0,
    );
    if (totalDocuments === 0) {
      throw new Error(
        `Every collection in database "${db.databaseName}" is empty. ` +
          `DATABASE_NAME (${process.env.DATABASE_NAME ?? 'unset'}) overrides the ` +
          `database in DATABASE_URL — check that both name the deployment you meant ` +
          `to measure, then run this again. Refusing to report zeros as a result.`,
      );
    }

    // Probe against the tenant that owns the most CRM records: the plan of a
    // query on an empty tenant tells you nothing.
    const probeTenant =
      reports
        .filter((report) =>
          ['deals', 'tickets', 'tasks', 'accounts'].includes(report.collection),
        )
        .flatMap((report) => report.topTenants)
        .sort((left, right) => right.count - left.count)[0]?.tenantId ?? null;

    const explains: ExplainReport[] = [];
    if (probeTenant && probeTenant !== 'null') {
      const { ObjectId } = await import('mongodb');
      const tenantId = ObjectId.isValid(probeTenant)
        ? new ObjectId(probeTenant)
        : probeTenant;
      for (const probe of searchProbes(tenantId, 'acme')) {
        explains.push(await explainProbe(db, probe));
      }
    }

    if (AS_JSON) {
      console.log(
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            database: db.databaseName,
            probeTenant,
            reports,
            explains,
          },
          null,
          2,
        ),
      );
    } else {
      printHuman(reports, explains, probeTenant, db.databaseName);
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
