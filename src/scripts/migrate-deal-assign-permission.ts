import 'dotenv/config';
import { MongoClient, ObjectId, type Collection, type Document } from 'mongodb';

const EDIT = 'deals:edit';
const ASSIGN = 'deals:assign';
const VIEW = 'deals:view';
const UNMASK = 'deals:unmask';

/**
 * Grandfather `deals:assign` onto every role that already holds `deals:edit`,
 * and `deals:unmask` onto every role that already holds `deals:view`.
 *
 * Why this exists
 * ----------------
 * Two new deal permissions were introduced by the Deal Module audit remediation:
 *
 *   - `deals:assign` — reassigning ownerId used to require only `deals:edit`,
 *     making a transfer indistinguishable from correcting a title. Ownership is
 *     the primary data-visibility axis, so it now needs its own grant
 *     (mirrors `contacts:assign`, see migrate-contact-assign-permission.ts).
 *   - `deals:unmask` — `deal.value`/`deal.probability` had NO field-level
 *     control at all; anyone holding `deals:view` saw the full amount. It now
 *     requires `deals:unmask` to see unmasked, gated via FIELD_SENSITIVITY.
 *
 * Both are enforced unconditionally in code (DealsService for assign,
 * FieldMaskingInterceptor for unmask). Run this migration BEFORE deploying
 * that code so existing roles keep their current capability, now represented
 * by an explicit permission instead of an implicit side effect of edit/view.
 *
 * Intended sequence per environment:
 *   1. run with `--dry-run` and review the affected roles/memberships;
 *   2. run this migration;
 *   3. run `npm run seed:system-roles`;
 *   4. deploy the enforcing API/UI;
 *   5. remove `deals:assign` / `deals:unmask` from roles that should not have them.
 *
 * `--strict` skips the grandfathering and instead REMOVES both permissions
 * from every non-system role, for an operator who would rather grant them
 * deliberately from zero. It is the more secure end state and the more
 * disruptive path.
 *
 * Usage:
 *   npm run migrate:deal-assign-permission -- --dry-run
 *   npm run migrate:deal-assign-permission -- --tenantId=6650...
 *   npm run migrate:deal-assign-permission -- --strict
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
  requiredPermission: string,
  grantedPermission: string,
): Promise<number> {
  const filter: Document = {
    ...tenantScope(args.tenantId),
    permissions: requiredPermission,
    // Only roles that do not already have it — keeps the run idempotent.
    $nor: [{ permissions: grantedPermission }],
  };

  if (args.dryRun) return roles.countDocuments(filter);

  const result = await roles.updateMany(filter, {
    $addToSet: { permissions: grantedPermission },
  });
  return result.modifiedCount;
}

async function revokeFromRoles(
  roles: Collection<Document>,
  args: Args,
  grantedPermission: string,
): Promise<number> {
  // System roles are owned by the template seeder; rewriting them here would be
  // undone on the next seed.
  const filter: Document = {
    ...tenantScope(args.tenantId),
    permissions: grantedPermission,
    isSystem: { $ne: true },
  };

  if (args.dryRun) return roles.countDocuments(filter);

  const result = await roles.updateMany(filter, {
    $pull: { permissions: grantedPermission },
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
  requiredPermission: string,
  grantedPermission: string,
): Promise<number> {
  const filter: Document = {
    'tenants.permissions': requiredPermission,
    ...(args.tenantId
      ? { 'tenants.tenantId': new ObjectId(args.tenantId) }
      : {}),
  };

  if (args.dryRun) return users.countDocuments(filter);

  // Positional $[] over the tenants array: a user can be a member of several
  // tenants, and only the memberships that carry the required permission
  // should gain the granted one.
  const result = await users.updateMany(
    filter,
    { $addToSet: { 'tenants.$[m].permissions': grantedPermission } },
    { arrayFilters: [{ [`m.permissions`]: requiredPermission }] },
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
      `deals:assign/deals:unmask migration — ${args.strict ? 'STRICT (revoke)' : 'grandfather'}` +
        `${args.tenantId ? `, tenant ${args.tenantId}` : ', ALL tenants'}`,
    );
    if (args.dryRun) console.log('DRY RUN — counting only, nothing written.');

    if (args.strict) {
      const revokedAssign = await revokeFromRoles(roles, args, ASSIGN);
      const revokedUnmask = await revokeFromRoles(roles, args, UNMASK);
      console.log(
        `  roles       ${revokedAssign} custom role(s) ${args.dryRun ? 'would lose' : 'lost'} ${ASSIGN}`,
      );
      console.log(
        `  roles       ${revokedUnmask} custom role(s) ${args.dryRun ? 'would lose' : 'lost'} ${UNMASK}`,
      );
      console.log(
        '\nGrant them deliberately from the Roles screen to the roles that should ' +
          'keep transfer/unmask ability before deploying the enforcing API.',
      );
      return;
    }

    const assignRoleCount = await grandfatherRoles(roles, args, EDIT, ASSIGN);
    console.log(
      `  roles       ${assignRoleCount} role(s) ${args.dryRun ? 'would gain' : 'gained'} ${ASSIGN}`,
    );
    const unmaskRoleCount = await grandfatherRoles(roles, args, VIEW, UNMASK);
    console.log(
      `  roles       ${unmaskRoleCount} role(s) ${args.dryRun ? 'would gain' : 'gained'} ${UNMASK}`,
    );

    const assignUserCount = await grandfatherMemberships(
      users,
      args,
      EDIT,
      ASSIGN,
    );
    console.log(
      `  memberships ${assignUserCount} user membership(s) ${args.dryRun ? 'would gain' : 'gained'} ${ASSIGN}`,
    );
    const unmaskUserCount = await grandfatherMemberships(
      users,
      args,
      VIEW,
      UNMASK,
    );
    console.log(
      `  memberships ${unmaskUserCount} user membership(s) ${args.dryRun ? 'would gain' : 'gained'} ${UNMASK}`,
    );

    if (!args.dryRun) {
      console.log(
        '\nNext: run `npm run seed:system-roles`, then deploy the enforcing API/UI.\n' +
          'After deployment, remove deals:assign/deals:unmask from roles that should\n' +
          'not transfer ownership / see deal amounts.',
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
