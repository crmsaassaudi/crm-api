import 'dotenv/config';
import { MongoClient, type Collection, type Document } from 'mongodb';

/**
 * Permission keys whose feature no longer exists. Mirrors
 * `DEPRECATED_PERMISSIONS` in src/common/permissions/permission.constants.ts.
 *
 * `automation_rules:*` — the `automation_rules` collection was CRUD-only with no
 * evaluator anywhere in the codebase, so tenants could grant these and author
 * rules that could never run. The API surface was removed 2026-07-28.
 */
const DEPRECATED_PERMISSIONS = [
  'automation_rules:view',
  'automation_rules:create',
  'automation_rules:edit',
  'automation_rules:delete',
];

/**
 * Strip deprecated permission keys from every place a tenant can store them:
 * custom roles, and the per-membership `permissions` / `permissionOverrides` on
 * users.
 *
 * Why this exists rather than just deleting the keys from the registry:
 * `CustomRolesService.validatePermissions` and
 * `UsersService.assertPermissionKeysValid` both check submitted keys against
 * ALL_PERMISSIONS. Removing a key while roles still hold it would make those
 * roles fail validation the next time anyone edited them — a self-inflicted
 * outage on the roles screen. So the keys stay valid, this migration clears
 * them, and only then can they be dropped from the registry.
 *
 * Idempotent: re-running it is a no-op once no document holds a deprecated key.
 */
async function stripFromCustomRoles(
  roles: Collection<Document>,
): Promise<number> {
  const result = await roles.updateMany(
    { permissions: { $in: DEPRECATED_PERMISSIONS } },
    {
      // Cast: the driver's PullOperator types a `$in` on a plain `Document`
      // collection as unassignable, though it is exactly the right query here.
      $pull: { permissions: { $in: DEPRECATED_PERMISSIONS } },
    } as Document,
  );
  console.log(
    `custom_roles: ${result.modifiedCount} role(s) had deprecated keys removed`,
  );
  return result.modifiedCount;
}

/**
 * Membership permissions live in an array of subdocuments (`tenants[]`), and
 * `permissionOverrides` is a Mixed map keyed BY permission, so neither can be
 * handled with a single `$pull`. Walk the documents that actually match.
 */
async function stripFromUsers(users: Collection<Document>): Promise<number> {
  const overrideKeyFilters = DEPRECATED_PERMISSIONS.map((key) => ({
    [`tenants.permissionOverrides.${key}`]: { $exists: true },
  }));

  const cursor = users.find({
    $or: [
      { 'tenants.permissions': { $in: DEPRECATED_PERMISSIONS } },
      ...overrideKeyFilters,
    ],
  });

  let modified = 0;
  for await (const user of cursor) {
    const tenants = Array.isArray(user.tenants) ? user.tenants : [];
    let touched = false;

    for (const membership of tenants) {
      if (Array.isArray(membership.permissions)) {
        const kept = membership.permissions.filter(
          (key: string) => !DEPRECATED_PERMISSIONS.includes(key),
        );
        if (kept.length !== membership.permissions.length) {
          membership.permissions = kept;
          touched = true;
        }
      }

      const overrides = membership.permissionOverrides;
      if (overrides && typeof overrides === 'object') {
        for (const key of DEPRECATED_PERMISSIONS) {
          if (key in overrides) {
            delete overrides[key];
            touched = true;
          }
        }
      }
    }

    if (touched) {
      await users.updateOne({ _id: user._id }, { $set: { tenants } });
      modified++;
    }
  }

  console.log(`users: ${modified} user(s) had deprecated keys removed`);
  return modified;
}

async function migrate(): Promise<void> {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log('✅ Connected to MongoDB\n');
    console.log(`Stripping: ${DEPRECATED_PERMISSIONS.join(', ')}\n`);

    const db = client.db();
    const roles = await stripFromCustomRoles(db.collection('custom_roles'));
    const users = await stripFromUsers(db.collection('users'));

    console.log('\n=== Migration Complete ===');
    console.log(`Roles updated: ${roles}, users updated: ${users}`);
    if (roles === 0 && users === 0) {
      console.log(
        'Nothing to do — the deprecated keys can now be removed from ' +
          'PERMISSION_REGISTRY in a follow-up release.',
      );
    }
  } catch (error) {
    console.error(
      'Migration failed:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  } finally {
    await client.close();
  }
}

migrate().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
