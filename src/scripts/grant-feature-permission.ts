import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import { FEATURE_PERMISSIONS } from '../common/permissions/permission.constants';

/**
 * Add or remove feature permissions on a tenant's `availablePermissions`.
 *
 * Feature permissions are absent from every tenant's catalogue until an
 * operator grants them, so a newly shipped one (e.g. `all_data:view`) exists in
 * code but cannot be assigned to any role until this runs. The manager console
 * does the same thing through the UI; this exists for environments that have no
 * console access — CI, a bare staging box, a one-off production fix.
 *
 * Usage:
 *   npm run grant:feature-permission -- --key=all_data:view --alias=master --dry-run
 *   npm run grant:feature-permission -- --key=all_data:view --alias=master
 *   npm run grant:feature-permission -- --key=all_data:view --tenantId=6650...
 *   npm run grant:feature-permission -- --key=all_data:view --all
 *   npm run grant:feature-permission -- --key=all_data:view --alias=master --revoke
 *
 * A target is mandatory: `--alias`, `--tenantId` or an explicit `--all`. There
 * is no "no filter means everyone" default, because the difference between
 * granting a full-tenant read to one workspace and to every workspace on the
 * cluster must not be a forgotten flag.
 *
 * Idempotent: `$addToSet` / `$pull`, so rerunning changes nothing. Roles that
 * already reference a revoked key keep it stored, but the engine drops it from
 * their effective set — revoking is safe and reversible.
 */

interface Args {
  key?: string;
  alias?: string;
  tenantId?: string;
  all: boolean;
  revoke: boolean;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const match = argv.find((arg) => arg.startsWith(`--${name}=`));
    return match ? match.slice(name.length + 3) : undefined;
  };
  return {
    key: get('key'),
    alias: get('alias'),
    tenantId: get('tenantId'),
    all: argv.includes('--all'),
    revoke: argv.includes('--revoke'),
    dryRun: argv.includes('--dry-run'),
  };
}

async function run() {
  const { key, alias, tenantId, all, revoke, dryRun } = parseArgs();

  if (!key) {
    console.error('--key=<permission> is required');
    console.error(
      `Known feature permissions:\n  ${FEATURE_PERMISSIONS.join('\n  ')}`,
    );
    process.exit(1);
  }

  // Only feature permissions belong in `availablePermissions`. A core key
  // written there is a no-op (it is already in the ceiling) and a typo would
  // sit in the database forever looking like a granted capability.
  if (!FEATURE_PERMISSIONS.includes(key)) {
    console.error(
      `"${key}" is not a feature permission. Core permissions are already in ` +
        'every tenant ceiling; only these can be granted:\n  ' +
        FEATURE_PERMISSIONS.join('\n  '),
    );
    process.exit(1);
  }

  if (!alias && !tenantId && !all) {
    console.error(
      'Pick a target: --alias=<tenant alias>, --tenantId=<id>, or --all to ' +
        'affect every tenant.',
    );
    process.exit(1);
  }

  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    console.log(`✅ Connected to MongoDB${dryRun ? ' (DRY RUN)' : ''}\n`);

    const filter: Record<string, unknown> = {};
    if (alias) filter.alias = alias;
    if (tenantId) filter._id = new ObjectId(tenantId);

    const tenants = await db
      .collection('tenants')
      .find(filter, { projection: { alias: 1, availablePermissions: 1 } })
      .toArray();

    if (!tenants.length) {
      console.log('No tenants matched — nothing to do.');
      return;
    }

    let changed = 0;
    for (const tenant of tenants) {
      const id = (tenant._id as ObjectId).toString();
      const label = `${String(tenant.alias ?? '—')} (${id})`;
      const current = (tenant.availablePermissions as string[] | null) ?? [];
      const has = current.includes(key);

      if (revoke ? !has : has) {
        console.log(`· ${label} already ${revoke ? 'without' : 'has'} ${key}`);
        continue;
      }

      changed++;
      console.log(`${revoke ? '−' : '+'} ${label} ${key}`);
      if (dryRun) continue;

      // Cast: the driver types `$pull`/`$addToSet` against a schema this
      // untyped `Document` collection does not carry, so a plain string value
      // fails to match `PullOperator`.
      const update = (
        revoke
          ? { $pull: { availablePermissions: key } }
          : { $addToSet: { availablePermissions: key } }
      ) as Record<string, unknown>;
      await db.collection('tenants').updateOne({ _id: tenant._id }, update);
    }

    console.log(
      `\n${dryRun ? 'Would change' : 'Changed'} ${changed} of ${tenants.length} tenant(s).`,
    );
    if (changed > 0 && !revoke) {
      // The seeder materialises `requiresFeature` templates only for tenants
      // whose ceiling contains the key, so a newly granted feature has no role
      // to go with it until it runs again.
      console.log(
        'Run `npm run seed:system-roles` next to materialise any system role ' +
          'gated on this feature (e.g. Auditor for all_data:view).',
      );
    }
  } finally {
    await client.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
