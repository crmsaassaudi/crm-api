import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

/**
 * Backfill `orgUnitId` on existing CRM records from their owner's org unit.
 *
 * Why this is needed, and when
 * ----------------------------
 * The ORG_UNIT / ORG_UNIT_SUBTREE data scopes match on `record.orgUnitId`, which
 * is stamped at create time from the creator's unit. Records written before the
 * org tree existed carry `null`, so they match no unit clause. That is the
 * fail-closed direction — nothing leaks — but the symptom is confusing: a
 * manager switched to ORG_UNIT scope sees their team's NEW records and not the
 * historical ones, which reads as data loss rather than as a missing backfill.
 *
 * Nothing regresses if you never run this. The default tenant scope is
 * SUBORDINATES, which is owner-based and ignores `orgUnitId` entirely. Run it
 * before switching a tenant to an org-unit scope, not before deploying.
 *
 * Usage:
 *   npm run backfill:org-units -- --dry-run
 *   npm run backfill:org-units -- --tenantId=6650...
 *   npm run backfill:org-units
 *
 * Idempotent: only documents with a null/missing `orgUnitId` are touched, so a
 * record deliberately filed in another unit (by an importer or a transfer) is
 * never rewritten. Safe to rerun; safe to interrupt.
 */

// Every collection whose schema declares `orgUnitId`. Keep in sync with the
// schema files — a collection missing here silently stays unscoped, which is
// exactly the class of gap this script exists to close.
const COLLECTIONS = [
  'accounts',
  'contacts',
  'deals',
  'omni_conversations',
  'tasks',
  'tickets',
] as const;

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

async function run(): Promise<void> {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const { dryRun, tenantId } = parseArgs();
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db();

    // Org placement lives on the membership, so `$elemMatch` is required:
    // matching `tenants.orgUnitId` and `tenants.tenantId` as separate top-level
    // keys would be satisfied by two DIFFERENT memberships, and the script
    // would stamp this tenant's records with another workspace's unit.
    const membershipMatch: Record<string, unknown> = {
      orgUnitId: { $ne: null },
    };
    if (tenantId) membershipMatch.tenantId = new ObjectId(tenantId);

    // One pass over users, grouped by unit: the update is then one bulk op per
    // (collection, unit) rather than one per record. A tenant with 100k contacts
    // and 12 units costs 72 writes, not 100k.
    const users = await db
      .collection('users')
      .find(
        { tenants: { $elemMatch: membershipMatch } },
        { projection: { _id: 1, tenants: 1 } },
      )
      .toArray();

    if (users.length === 0) {
      console.log(
        'No users have an orgUnitId yet — assign users to org units first.',
      );
      return;
    }

    const ownersByUnit = new Map<string, ObjectId[]>();
    for (const user of users) {
      // Re-select the membership in memory: the projection returns the whole
      // array, and without a tenant filter a user may be placed in several.
      const memberships = (user.tenants ?? []).filter(
        (row: any) =>
          row?.orgUnitId &&
          (!tenantId || String(row.tenantId) === String(tenantId)),
      );
      for (const membership of memberships) {
        const unit = String(membership.orgUnitId);
        if (!ownersByUnit.has(unit)) ownersByUnit.set(unit, []);
        ownersByUnit.get(unit)!.push(user._id as ObjectId);
      }
    }

    console.log(
      `${users.length} assigned user(s) across ${ownersByUnit.size} org unit(s)` +
        (tenantId ? ` in tenant ${tenantId}` : ' (all tenants)'),
    );
    if (dryRun)
      console.log('DRY RUN — counting only, nothing will be written.');

    let grandTotal = 0;

    for (const collectionName of COLLECTIONS) {
      const collection = db.collection(collectionName);
      let touched = 0;

      for (const [unitId, ownerIds] of ownersByUnit) {
        // `$in: [null]` also matches documents where the field is absent, which
        // is what pre-rename rows look like.
        const filter = {
          ownerId: { $in: ownerIds },
          orgUnitId: { $in: [null] },
        };

        if (dryRun) {
          touched += await collection.countDocuments(filter);
          continue;
        }

        const result = await collection.updateMany(filter, {
          $set: { orgUnitId: new ObjectId(unitId) },
        });
        touched += result.modifiedCount;
      }

      grandTotal += touched;
      console.log(`  ${collectionName.padEnd(20)} ${touched}`);
    }

    console.log(
      `\nTotal records ${dryRun ? 'to update' : 'updated'}: ${grandTotal}`,
    );

    if (!dryRun && grandTotal > 0) {
      console.log(
        'Records with no owner, or whose owner has no org unit, were left null —' +
          '\nthey stay visible through ownerId only. Assign those users a unit and rerun.',
      );
    }
  } catch (error) {
    console.error(
      'Backfill failed:',
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
