import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

/**
 * Populate `nameKey`, `websiteDomain` and `taxIdKey` on existing accounts.
 *
 * `AccountsService` derives these on every create and on any update that touches
 * `name`, `website` or `taxId`, so this is a one-time seed per environment. Until it
 * runs, duplicate detection sees only accounts written since the deploy — it will not
 * report a wrong answer, it will report an incomplete one, which for an advisory
 * warning means silence rather than a false negative dressed as certainty.
 *
 * ── This one reports duplicates rather than resolving them ──
 *
 * Unlike the contact identity backfill, there is no unique index to violate: company
 * identity has no key strong enough to enforce. A shared tax id IS conclusive, a shared
 * domain nearly always is, and a name match after suffix-stripping frequently is not —
 * "Acme Ltd" and "Acme GmbH" reduce to the same key and are different legal entities in
 * different jurisdictions. Enforcing any of it would merge real companies.
 *
 * So this writes the keys and then tells you what they reveal, ranked by confidence.
 * Merging is a human decision per pair.
 *
 * Usage:
 *   npm run backfill:account-identity-keys -- --dry-run
 *   npm run backfill:account-identity-keys -- --tenantId=6650...
 *
 * Idempotent: recomputing a key from unchanged input produces the same value.
 */

const BATCH_SIZE = 500;
const SAMPLE_LIMIT = 30;

interface Args {
  dryRun: boolean;
  tenantId?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (key: string) => {
    const match = argv.find((a) => a.startsWith(`--${key}=`));
    return match ? match.slice(key.length + 3) : undefined;
  };
  return { dryRun: argv.includes('--dry-run'), tenantId: get('tenantId') };
}

// Mirrors common/identity/company-identity.ts. Duplicated because this runs on a raw
// MongoClient with no Nest container; company-identity.spec.ts is the reference
// behaviour and the two must stay in step.
const LEGAL_SUFFIXES = [
  'cong ty tnhh mtv',
  'cong ty tnhh',
  'cong ty co phan',
  'cong ty cp',
  'cong ty',
  'tnhh mtv',
  'tnhh',
  'co phan',
  'jsc',
  'cp',
  'incorporated',
  'corporation',
  'company',
  'limited',
  'holdings',
  'holding',
  'group',
  'inc',
  'corp',
  'llc',
  'llp',
  'ltd',
  'plc',
  'gmbh',
  'ag',
  'sa',
  'nv',
  'bv',
  'oy',
  'ab',
  'as',
  'pte',
  'pty',
  'co',
];

const TWO_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.vn',
  'net.vn',
  'org.vn',
  'edu.vn',
  'gov.vn',
  'com.au',
  'net.au',
  'com.sg',
  'com.my',
  'co.jp',
  'co.kr',
  'com.br',
  'co.in',
  'com.cn',
]);

function normalizeCompanyName(value: unknown): string {
  if (typeof value !== 'string') return '';
  let name = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (name === suffix) continue;
      if (name.endsWith(` ${suffix}`)) {
        name = name.slice(0, -(suffix.length + 1)).trim();
        changed = true;
        break;
      }
      if (name.startsWith(`${suffix} `)) {
        name = name.slice(suffix.length + 1).trim();
        changed = true;
        break;
      }
    }
  }
  return name;
}

function normalizeWebsiteDomain(value: unknown): string {
  if (typeof value !== 'string') return '';
  let host = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^/@]*@/, '')
    .split(/[/?#]/)[0]
    .split(':')[0]
    .replace(/\.$/, '');
  if (!host || !host.includes('.')) return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return '';
  if (host.startsWith('www.')) host = host.slice(4);
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return '';
  const lastTwo = labels.slice(-2).join('.');
  return labels.slice(TWO_LABEL_SUFFIXES.has(lastTwo) ? -3 : -2).join('.');
}

const normalizeTaxId = (value: unknown): string =>
  typeof value === 'string'
    ? value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
    : '';

async function run(): Promise<void> {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const args = parseArgs();
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const accounts = client.db().collection('accounts');

    const filter: Record<string, unknown> = { deletedAt: null };
    if (args.tenantId) filter.tenantId = new ObjectId(args.tenantId);

    console.log(
      `Deriving account identity keys${
        args.tenantId ? ` for tenant ${args.tenantId}` : ' for ALL tenants'
      }…`,
    );
    if (args.dryRun) console.log('DRY RUN — nothing will be written.');

    // Collisions are grouped as they are found, so the report below is a by-product of
    // the pass rather than a second scan.
    const byTax = new Map<string, string[]>();
    const byDomain = new Map<string, string[]>();
    const byName = new Map<string, string[]>();

    let scanned = 0;
    let written = 0;
    let ops: any[] = [];

    const flush = async () => {
      if (ops.length === 0) return;
      if (!args.dryRun) await accounts.bulkWrite(ops, { ordered: false });
      written += ops.length;
      ops = [];
    };

    const track = (
      map: Map<string, string[]>,
      key: string,
      tenantId: unknown,
      id: string,
    ) => {
      if (!key) return;
      const scoped = `${String(tenantId)}|${key}`;
      if (!map.has(scoped)) map.set(scoped, []);
      map.get(scoped)!.push(id);
    };

    const cursor = accounts
      .find(filter, {
        projection: { name: 1, website: 1, taxId: 1, tenantId: 1 },
      })
      .batchSize(BATCH_SIZE);

    for await (const account of cursor) {
      scanned++;
      const nameKey = normalizeCompanyName(account.name);
      const websiteDomain = normalizeWebsiteDomain(account.website);
      const taxIdKey = normalizeTaxId(account.taxId);
      const id = String(account._id);

      track(byTax, taxIdKey, account.tenantId, id);
      track(byDomain, websiteDomain, account.tenantId, id);
      track(byName, nameKey, account.tenantId, id);

      ops.push({
        updateOne: {
          filter: { _id: account._id },
          update: { $set: { nameKey, websiteDomain, taxIdKey } },
        },
      });
      if (ops.length >= BATCH_SIZE) await flush();
    }
    await flush();

    console.log(
      `\n  accounts scanned  ${scanned}\n` +
        `  keys ${args.dryRun ? 'to write' : 'written'}    ${written}`,
    );

    const report = (
      label: string,
      map: Map<string, string[]>,
      note: string,
    ) => {
      const groups = [...map.entries()].filter(([, ids]) => ids.length > 1);
      if (groups.length === 0) return;
      console.log(`\n${label} — ${groups.length} group(s). ${note}`);
      for (const [key, ids] of groups.slice(0, SAMPLE_LIMIT)) {
        console.log(`  ${key.split('|')[1]}: ${ids.join(', ')}`);
      }
      if (groups.length > SAMPLE_LIMIT) {
        console.log(`  … and ${groups.length - SAMPLE_LIMIT} more`);
      }
    };

    // Ordered by how much the signal is worth acting on.
    report(
      'EXACT — same tax id',
      byTax,
      'A tax id identifies one legal entity: these ARE the same company.',
    );
    report(
      'STRONG — same web domain',
      byDomain,
      'Organisations rarely share a registrable domain; check for subsidiaries.',
    );
    report(
      'WEAK — same normalised name',
      byName,
      'Suffix stripping collides different legal forms ("Acme Ltd" vs "Acme GmbH"). Review individually.',
    );

    if (!args.dryRun) {
      console.log(
        '\nKeys written. Duplicate detection now covers historical accounts.\n' +
          'Nothing was merged: company identity has no key strong enough to enforce\n' +
          'automatically, so each pair above is a human decision.',
      );
    }
  } finally {
    await client.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
