import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import {
  SYSTEM_ROLE_TEMPLATES,
  resolveTemplatePermissions,
} from '../common/permissions/system-role-templates';
import { CORE_PERMISSIONS } from '../common/permissions/permission.constants';

/**
 * Backfill / re-sync the built-in system roles for tenants.
 *
 * Tenants created before system roles existed have an empty Roles page; tenants
 * created after get them from TenantCreatedListener. This script covers the
 * former, and also re-syncs everyone after a template `version` bump.
 *
 * Usage:
 *   npm run seed:system-roles -- --dry-run
 *   npm run seed:system-roles
 *   npm run seed:system-roles -- --alias=master
 *   npm run seed:system-roles -- --tenantId=6650...
 *
 * Idempotent and keyed on `systemKey`, never on the display name. Safe to rerun.
 * Re-syncing only ever touches rows this script created (isSystem + systemKey),
 * which the API refuses to let tenants edit — so no customer work is lost.
 */

interface Args {
  dryRun: boolean;
  alias?: string;
  tenantId?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (key: string) => {
    const match = argv.find((a) => a.startsWith(`--${key}=`));
    return match ? match.slice(key.length + 3) : undefined;
  };
  return {
    dryRun: argv.includes('--dry-run'),
    alias: get('alias'),
    tenantId: get('tenantId'),
  };
}

const sameSet = (left: string[], right: string[]) => {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
};

async function run() {
  const { dryRun, alias, tenantId } = parseArgs();
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  const totals = { tenants: 0, created: 0, resynced: 0, skipped: 0 };

  try {
    await client.connect();
    const db = client.db();
    console.log(`✅ Connected to MongoDB${dryRun ? ' (DRY RUN)' : ''}\n`);

    // `autoIndex` is off in production (mongoose-config.service.ts), so the
    // partial unique index that keeps one row per (tenant, systemKey) has to be
    // created here. createIndex is idempotent.
    if (!dryRun) {
      await db.collection('custom_roles').createIndex(
        { tenantId: 1, systemKey: 1 },
        {
          unique: true,
          partialFilterExpression: { systemKey: { $type: 'string' } },
          name: 'tenantId_1_systemKey_1',
        },
      );
      console.log('Index tenantId_1_systemKey_1 ensured on custom_roles\n');
    }

    const filter: Record<string, unknown> = {};
    if (alias) filter.alias = alias;
    if (tenantId) filter._id = new ObjectId(tenantId);

    const tenants = await db.collection('tenants').find(filter).toArray();
    if (!tenants.length) {
      console.log('No tenants matched — nothing to do.');
      return;
    }

    for (const tenant of tenants) {
      const id = (tenant._id as ObjectId).toString();
      const label = `${String(tenant.alias ?? '—')} (${id})`;
      totals.tenants++;

      // Ceiling = CORE ∪ availablePermissions ∖ disabledCorePermissions.
      // Mirrors getTenantPermissions() in permission.engine.ts.
      const disabled = new Set<string>(
        (tenant.disabledCorePermissions as string[] | null) ?? [],
      );
      const ceiling = new Set<string>(
        CORE_PERMISSIONS.filter((key) => !disabled.has(key)),
      );
      for (const key of (tenant.availablePermissions as string[] | null) ??
        []) {
        ceiling.add(key);
      }

      const rows = await db
        .collection('custom_roles')
        .find({ tenantId: id, systemKey: { $type: 'string' } })
        .toArray();
      const bySystemKey = new Map(
        rows.map((row) => [String(row.systemKey), row]),
      );

      const actions: string[] = [];

      for (const template of SYSTEM_ROLE_TEMPLATES) {
        const existing = bySystemKey.get(template.systemKey);

        if (
          template.requiresFeature &&
          !ceiling.has(template.requiresFeature) &&
          !existing
        ) {
          totals.skipped++;
          actions.push(`· ${template.systemKey} skipped (feature not granted)`);
          continue;
        }

        const permissions = resolveTemplatePermissions(template, ceiling);
        const now = new Date();

        if (!existing) {
          // `tenantId + name` is unique — a hand-made role may already own the name.
          const nameTaken = await db
            .collection('custom_roles')
            .findOne({ tenantId: id, name: template.name });
          const name = nameTaken ? `${template.name} (System)` : template.name;

          if (!dryRun) {
            await db.collection('custom_roles').insertOne({
              tenantId: id,
              systemKey: template.systemKey,
              templateVersion: template.version,
              isSystem: true,
              name,
              description: template.description,
              color: template.color,
              permissions,
              createdAt: now,
              updatedAt: now,
            });
          }
          totals.created++;
          actions.push(
            `+ ${template.systemKey} created as "${name}" (${permissions.length} perms)`,
          );
          continue;
        }

        const outdated =
          Number(existing.templateVersion ?? 0) < template.version ||
          !sameSet((existing.permissions as string[]) ?? [], permissions);

        if (!outdated) continue;

        if (!dryRun) {
          await db.collection('custom_roles').updateOne(
            { _id: existing._id },
            {
              $set: {
                description: template.description,
                color: template.color,
                permissions,
                isSystem: true,
                templateVersion: template.version,
                updatedAt: now,
              },
            },
          );
        }
        totals.resynced++;
        actions.push(
          `~ ${template.systemKey} re-synced to v${template.version} (${permissions.length} perms)`,
        );
      }

      if (actions.length) {
        console.log(`Tenant ${label}`);
        actions.forEach((line) => console.log(`   ${line}`));
      } else {
        console.log(`Tenant ${label} — already up to date`);
      }
    }

    console.log('\n=== Summary ===');
    console.log(`  tenants processed: ${totals.tenants}`);
    console.log(`  roles created:     ${totals.created}`);
    console.log(`  roles re-synced:   ${totals.resynced}`);
    console.log(`  templates skipped: ${totals.skipped}`);
    if (dryRun) console.log('\n  DRY RUN — nothing was written.');
    if (!dryRun && (totals.created || totals.resynced)) {
      console.log(
        '\n  Restart the API (or wait for cache TTL) so cached permission sets pick up the new roles.',
      );
    }
  } catch (error) {
    console.error(
      'Seeding failed:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  } finally {
    await client.close();
  }
}

run().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
