import 'dotenv/config';
import { MongoClient, ObjectId, type Collection, type Document } from 'mongodb';

const EDIT = 'contacts:edit';
const ASSIGN = 'contacts:assign';

/**
 * Grandfather `contacts:assign` onto every role that already holds
 * `contacts:edit`.
 *
 * Why this exists
 * ---------------
 * Reassigning a contact's owner used to require only `contacts:edit`, which made
 * a transfer indistinguishable from correcting a phone number. That matters
 * because ownership is the primary data-visibility axis: an agent could quietly
 * move records into their own scope, or a colleague's out of theirs, with the same
 * permission they use to type. `contacts:assign` now exists to separate the two.
 *
 * Enforcement is unconditional in ContactsService. Run this migration BEFORE
 * deploying that code so existing editors keep their current transfer ability,
 * now represented by an explicit permission instead of a fail-open feature flag.
 *
 * Intended sequence per environment:
 *   1. run with `--dry-run` and review the affected roles/memberships;
 *   2. run this migration;
 *   3. run `npm run seed:system-roles` (Manager template version 3);
 *   4. deploy the enforcing API/UI;
 *   5. remove `contacts:assign` from roles that should not transfer records.
 *
 * `--strict` skips the grandfathering and instead REMOVES `contacts:assign` from
 * every non-system role, for an operator who would rather grant it deliberately
 * from zero. It is the more secure end state and the more disruptive path.
 *
 * Usage:
 *   npm run migrate:contact-assign-permission -- --dry-run
 *   npm run migrate:contact-assign-permission -- --tenantId=6650...
 *   npm run migrate:contact-assign-permission -- --strict
 *
 * Idempotent either way.
 */

interface Args {
  dryRun: boolean;
  tenantId?: string;
  strict: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (key: string) => {
    const match = argv.find((a) => a.startsWith(`--${key}=`));
    return match ? match.slice(key.length + 3) : undefined;
  };
  return {
    dryRun: argv.includes('--dry-run'),
    tenantId: get('tenantId'),
    strict: argv.includes('--strict'),
  };
}

function tenantScope(tenantId?: string): Document {
  return tenantId ? { tenantId: new ObjectId(tenantId) } : {};
}

async function grandfatherRoles(
  roles: Collection<Document>,
  args: Args,
): Promise<number> {
  const filter: Document = {
    ...tenantScope(args.tenantId),
    permissions: EDIT,
    // Only roles that do not already have it — keeps the run idempotent.
    $nor: [{ permissions: ASSIGN }],
  };

  if (args.dryRun) return roles.countDocuments(filter);

  const result = await roles.updateMany(filter, {
    $addToSet: { permissions: ASSIGN },
  });
  return result.modifiedCount;
}

async function revokeFromRoles(
  roles: Collection<Document>,
  args: Args,
): Promise<number> {
  // System roles are owned by the template seeder; rewriting them here would be
  // undone on the next seed and would fight the Manager template that is
  // supposed to hold this permission.
  const filter: Document = {
    ...tenantScope(args.tenantId),
    permissions: ASSIGN,
    isSystem: { $ne: true },
  };

  if (args.dryRun) return roles.countDocuments(filter);

  const result = await roles.updateMany(filter, {
    $pull: { permissions: ASSIGN },
  } as Document);
  return result.modifiedCount;
}

/**
 * Per-membership permission grants, the other place a tenant can store keys.
 * `UsersService.assertPermissionKeysValid` validates against ALL_PERMISSIONS, so
 * these stay consistent with the role pass above.
 */
async function grandfatherMemberships(
  users: Collection<Document>,
  args: Args,
): Promise<number> {
  const filter: Document = {
    'tenants.permissions': EDIT,
    ...(args.tenantId
      ? { 'tenants.tenantId': new ObjectId(args.tenantId) }
      : {}),
  };

  if (args.dryRun) return users.countDocuments(filter);

  // Positional $[] over the tenants array: a user can be a member of several
  // tenants, and only the memberships that carry `contacts:edit` should gain it.
  const result = await users.updateMany(
    filter,
    { $addToSet: { 'tenants.$[m].permissions': ASSIGN } },
    { arrayFilters: [{ 'm.permissions': EDIT }] },
  );
  return result.modifiedCount;
}

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
    const db = client.db();
    const roles = db.collection('custom_roles');
    const users = db.collection('users');

    console.log(
      `contacts:assign migration — ${args.strict ? 'STRICT (revoke)' : 'grandfather'}` +
        `${args.tenantId ? `, tenant ${args.tenantId}` : ', ALL tenants'}`,
    );
    if (args.dryRun) console.log('DRY RUN — counting only, nothing written.');

    if (args.strict) {
      const revoked = await revokeFromRoles(roles, args);
      console.log(
        `  roles       ${revoked} custom role(s) ${args.dryRun ? 'would lose' : 'lost'} ${ASSIGN}`,
      );
      console.log(
        '\nGrant it deliberately from the Roles screen to the roles that should ' +
          'be able to transfer records before deploying the enforcing API.',
      );
      return;
    }

    const roleCount = await grandfatherRoles(roles, args);
    console.log(
      `  roles       ${roleCount} role(s) ${args.dryRun ? 'would gain' : 'gained'} ${ASSIGN}`,
    );

    const userCount = await grandfatherMemberships(users, args);
    console.log(
      `  memberships ${userCount} user membership(s) ${args.dryRun ? 'would gain' : 'gained'} ${ASSIGN}`,
    );

    if (!args.dryRun) {
      console.log(
        '\nNext: run `npm run seed:system-roles`, then deploy the enforcing API/UI.\n' +
          'After deployment, remove contacts:assign from roles that should not\n' +
          'transfer Contact ownership.',
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
