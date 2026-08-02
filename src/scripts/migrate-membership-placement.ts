/**
 * Move `orgUnitId` / `reportsToId` from the user document onto each membership.
 *
 * They were top-level fields, which meant one org unit and one manager per
 * PERSON rather than per workspace. Anyone belonging to two tenants therefore
 * had a single placement shared between them: joining a second workspace
 * silently re-filed them in the first, and every ORG_UNIT-scoped query over
 * there started matching nothing. The fields now live on `tenants[]`.
 *
 * The old value cannot be attributed to a particular workspace after the fact,
 * so it is copied to every membership that has none. For a single-tenant user —
 * which is nearly all of them — that reproduces exactly what they had. A user
 * in several tenants gets the same unit in each, which is the previous
 * behaviour too; an admin can correct it per workspace afterwards, which is the
 * whole point of the change.
 *
 * Idempotent: a membership that already carries a placement is left alone, and
 * the top-level fields are only unset once every membership has been filled.
 *
 *   npm run migrate:membership-placement -- --dry-run
 *   npm run migrate:membership-placement
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';

function parseArgs(): { dryRun: boolean } {
  return { dryRun: process.argv.includes('--dry-run') };
}

async function main(): Promise<void> {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const { dryRun } = parseArgs();
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const users = client.db().collection('users');

    const stale = await users
      .find(
        {
          $or: [{ orgUnitId: { $ne: null } }, { reportsToId: { $ne: null } }],
        },
        { projection: { _id: 1, orgUnitId: 1, reportsToId: 1, tenants: 1 } },
      )
      .toArray();

    console.log(
      `${stale.length} user(s) still carry a top-level placement` +
        (dryRun ? ' — DRY RUN, nothing will be written.' : ''),
    );

    let migrated = 0;
    for (const user of stale) {
      const memberships = user.tenants ?? [];
      if (memberships.length === 0) continue;

      const next = memberships.map((membership: any) => ({
        ...membership,
        orgUnitId: membership.orgUnitId ?? user.orgUnitId ?? null,
        reportsToId: membership.reportsToId ?? user.reportsToId ?? null,
      }));

      if (dryRun) {
        migrated += 1;
        continue;
      }

      await users.updateOne(
        { _id: user._id },
        {
          $set: { tenants: next },
          $unset: { orgUnitId: '', reportsToId: '' },
        },
      );
      migrated += 1;
    }

    console.log(
      `${migrated} user(s) ${dryRun ? 'would be migrated' : 'migrated'}.`,
    );

    // Users with no membership at all keep nothing worth moving; clear the dead
    // fields so a later run has nothing left to find.
    if (!dryRun) {
      const cleared = await users.updateMany(
        {
          $or: [
            { orgUnitId: { $exists: true } },
            { reportsToId: { $exists: true } },
          ],
        },
        { $unset: { orgUnitId: '', reportsToId: '' } },
      );
      console.log(`${cleared.modifiedCount} residual field(s) cleared.`);
    }
  } finally {
    await client.close();
  }
}

void main();
