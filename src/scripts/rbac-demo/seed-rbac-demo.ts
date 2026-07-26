import 'dotenv/config';
import axios from 'axios';
import { Db, MongoClient, ObjectId } from 'mongodb';
import Redis from 'ioredis';

import {
  ACLS,
  CONTACTS,
  DEMO_PASSWORD,
  DEMO_TENANT_ALIAS,
  EMAIL,
  GROUPS,
  LEGACY,
  ORG_UNITS,
  POLICIES,
  ROLES,
  SEED_TAG,
  USERS,
} from './rbac-demo.blueprint';

/**
 * Seeds the RBAC / ABAC fixture described by rbac-demo.blueprint.ts into a LOCAL
 * environment: Keycloak accounts plus the Mongo rows (org units, custom roles,
 * groups, memberships, JIT grants, ABAC policies, object ACLs, contacts).
 *
 * Usage:
 *   npm run seed:rbac-demo -- --dry-run
 *   npm run seed:rbac-demo
 *   npm run seed:rbac-demo -- --reset      # remove the fixture, then reseed
 *   npm run seed:rbac-demo -- --purge      # remove the fixture and stop
 *
 * Every step is find-or-create keyed on a stable identifier (org-unit `code`,
 * role/group `name`, user `email`, contact `email`), so rerunning converges
 * instead of duplicating. Every row written is stamped `seedTag: SEED_TAG`, and
 * `--reset` / `--purge` match on nothing else — the display text is ordinary
 * business text and must never be what cleanup keys on, or a hand-made role
 * that happens to share a name would be deleted with the fixture.
 *
 * Direct collection writes rather than the Nest models, deliberately: the
 * tenant-filter plugin fails closed without a CLS request context, and booting
 * the full app would start queues and workers this script has no use for. The
 * shapes written here mirror the schemas exactly — see the field notes inline.
 */

const REFUSE_IN_PRODUCTION = 'production';

interface Args {
  dryRun: boolean;
  reset: boolean;
  purge: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  return {
    dryRun: argv.includes('--dry-run'),
    reset: argv.includes('--reset'),
    purge: argv.includes('--purge'),
  };
}

// ── Keycloak admin REST (same realm/credentials the API uses) ────────────────

class KeycloakAdmin {
  private token = '';

  constructor(
    private readonly baseUrl: string,
    private readonly realm: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  async authenticate(): Promise<void> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const { data } = await axios.post(
      `${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/token`,
      body.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    this.token = data.access_token;
  }

  private get headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  private admin(path: string): string {
    return `${this.baseUrl}/admin/realms/${this.realm}${path}`;
  }

  async findUserByEmail(email: string): Promise<{ id: string } | null> {
    const { data } = await axios.get(
      this.admin(`/users?email=${encodeURIComponent(email)}&exact=true`),
      { headers: this.headers },
    );
    return Array.isArray(data) && data.length ? { id: data[0].id } : null;
  }

  async createUser(
    email: string,
    fullName: string,
    password: string,
  ): Promise<{ id: string }> {
    const spaceIdx = fullName.indexOf(' ');
    const firstName = spaceIdx > -1 ? fullName.slice(0, spaceIdx) : fullName;
    const lastName = spaceIdx > -1 ? fullName.slice(spaceIdx + 1) : '';

    await axios.post(
      this.admin('/users'),
      {
        email,
        username: email,
        firstName,
        lastName,
        enabled: true,
        emailVerified: true,
        credentials: [{ type: 'password', value: password, temporary: false }],
      },
      { headers: this.headers },
    );

    const created = await this.findUserByEmail(email);
    if (!created) {
      throw new Error(`Keycloak did not return the created user for ${email}`);
    }
    return created;
  }

  /**
   * Reset the password on an existing account. Rerunning the seeder must leave
   * every demo login working with the documented password, even if someone
   * changed it by hand while testing.
   */
  async setPassword(userId: string, password: string): Promise<void> {
    await axios.put(
      this.admin(`/users/${userId}/reset-password`),
      { type: 'password', value: password, temporary: false },
      { headers: this.headers },
    );
  }

  async deleteUser(userId: string): Promise<void> {
    await axios.delete(this.admin(`/users/${userId}`), {
      headers: this.headers,
    });
  }

  async findOrganizationId(alias: string): Promise<string | null> {
    try {
      const { data } = await axios.get(
        this.admin(`/organizations?search=${encodeURIComponent(alias)}`),
        { headers: this.headers },
      );
      const match = (Array.isArray(data) ? data : []).find(
        (org: any) => org.alias === alias || org.name === alias,
      );
      return match?.id ?? null;
    } catch {
      // Organizations disabled on this realm — not fatal for API auth, which
      // resolves the tenant from the subdomain and the Mongo membership.
      return null;
    }
  }

  async addUserToOrganization(orgId: string, userId: string): Promise<void> {
    try {
      await axios.post(this.admin(`/organizations/${orgId}/members`), userId, {
        headers: { ...this.headers, 'Content-Type': 'application/json' },
      });
    } catch (error: any) {
      if (error?.response?.status !== 409) {
        console.warn(
          `   ! could not add ${userId} to KC org: ${
            error?.response?.data?.errorMessage ?? error?.message
          }`,
        );
      }
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const log = (line: string) => console.log(line);

/** The one predicate cleanup keys on. */
const seeded = { seedTag: SEED_TAG };

/** Stamped onto every document this script writes or re-syncs. */
const stamp = { seedTag: SEED_TAG };

async function resolveTenant(db: Db) {
  const tenant = await db
    .collection('tenants')
    .findOne({ alias: DEMO_TENANT_ALIAS });
  if (!tenant) {
    throw new Error(
      `Tenant alias "${DEMO_TENANT_ALIAS}" not found. Run \`npm run init:master-org\` first.`,
    );
  }
  return tenant;
}

/**
 * Delete the accounts matching `userFilter`, in Keycloak as well as Mongo.
 * Returns how many Mongo rows went.
 */
async function deleteAccounts(
  db: Db,
  kc: KeycloakAdmin,
  userFilter: Record<string, unknown>,
  dryRun: boolean,
): Promise<number> {
  const userDocs = await db.collection('users').find(userFilter).toArray();
  if (dryRun) return userDocs.length;

  for (const doc of userDocs) {
    if (doc.keycloakId) {
      await kc.deleteUser(String(doc.keycloakId)).catch(() => {
        /* already gone */
      });
    }
  }
  await db.collection('users').deleteMany(userFilter);
  return userDocs.length;
}

/**
 * Remove every row this fixture owns — keyed on `seedTag`, never on display text.
 */
async function purge(
  db: Db,
  kc: KeycloakAdmin,
  tenantId: string,
  dryRun: boolean,
) {
  const oid = new ObjectId(tenantId);
  const emails = USERS.map((user) => user.email);

  const counts = {
    contacts: await db
      .collection('contacts')
      .countDocuments({ tenantId: oid, ...seeded }),
    policies: await db
      .collection('access_policies')
      .countDocuments({ tenantId, ...seeded }),
    acls: await db
      .collection('object_acl')
      .countDocuments({ tenantId, ...seeded }),
    assignments: await db
      .collection('role_assignments')
      .countDocuments({ tenantId, ...seeded }),
    groups: await db
      .collection('groups')
      .countDocuments({ tenantId: oid, ...seeded }),
    roles: await db
      .collection('custom_roles')
      .countDocuments({ tenantId, ...seeded }),
    orgUnits: await db
      .collection('org_units')
      .countDocuments({ tenantId: oid, ...seeded }),
    users: await db
      .collection('users')
      .countDocuments({ email: { $in: emails } }),
  };

  log(`Purging fixture rows: ${JSON.stringify(counts)}`);
  if (dryRun) return;

  await db.collection('contacts').deleteMany({ tenantId: oid, ...seeded });
  await db.collection('object_acl').deleteMany({ tenantId, ...seeded });
  await db.collection('access_policies').deleteMany({ tenantId, ...seeded });
  await db.collection('role_assignments').deleteMany({ tenantId, ...seeded });
  await db.collection('groups').deleteMany({ tenantId: oid, ...seeded });
  await db.collection('custom_roles').deleteMany({ tenantId, ...seeded });
  await db.collection('org_units').deleteMany({ tenantId: oid, ...seeded });
  await deleteAccounts(db, kc, { email: { $in: emails } }, dryRun);
}

/**
 * Clear rows left behind by the revision of this fixture that prefixed its
 * display text with "Demo RBAC · " and put its accounts on `rbacdemo.local`.
 *
 * Runs on every seed, not only on `--reset`: the current lookup keys match none
 * of those rows, so without this a rename leaves a second, marker-branded copy
 * of the whole fixture sitting in the Roles and Users lists — which is exactly
 * the appearance the rename was meant to remove.
 */
async function purgeLegacy(
  db: Db,
  kc: KeycloakAdmin,
  tenantId: string,
  dryRun: boolean,
) {
  const oid = new ObjectId(tenantId);
  const byName = { name: { $regex: `^${LEGACY.namePrefix} · ` } };
  const byEmail = { email: { $regex: `@${LEGACY.emailDomain}$` } };

  // Legacy ACL rows are identified by their principal — the legacy users and
  // groups — so they have to be collected before those rows are deleted. Keying
  // on anything looser (every contacts ACL in the tenant, say) would take real
  // record-level grants with it.
  const legacyPrincipalIds = [
    ...(
      await db.collection('users').find(byEmail).project({ _id: 1 }).toArray()
    ).map((doc) => doc._id.toString()),
    ...(
      await db
        .collection('groups')
        .find({ tenantId: oid, ...byName })
        .project({ _id: 1 })
        .toArray()
    ).map((doc) => doc._id.toString()),
  ];

  const targets: Array<[string, Record<string, unknown>]> = [
    ['object_acl', { tenantId, principalId: { $in: legacyPrincipalIds } }],
    ['contacts', { tenantId: oid, tags: LEGACY.contactTag }],
    ['access_policies', { tenantId, ...byName }],
    [
      'role_assignments',
      { tenantId, reason: { $regex: `^${LEGACY.jitReasonPrefix}` } },
    ],
    ['groups', { tenantId: oid, ...byName }],
    ['custom_roles', { tenantId, ...byName }],
    ['org_units', { tenantId: oid, code: { $in: [...LEGACY.orgUnitCodes] } }],
  ];

  const counts: Record<string, number> = {};
  for (const [collection, filter] of targets) {
    const found = await db.collection(collection).countDocuments(filter);
    if (!found) continue;
    counts[collection] = found;
    if (!dryRun) await db.collection(collection).deleteMany(filter);
  }

  const users = await deleteAccounts(db, kc, byEmail, dryRun);
  if (users) counts.users = users;

  if (Object.keys(counts).length) {
    log(
      `   ! removed rows from the previous "Demo RBAC" fixture: ${JSON.stringify(counts)}`,
    );
  }
}

// ── Seed steps ──────────────────────────────────────────────────────────────

/**
 * Refuse to write over a row this fixture does not own.
 *
 * Now that the fixture uses ordinary business names, "Trưởng phòng Kinh doanh"
 * is a name a tenant may well have typed itself — and re-syncing would overwrite
 * that role's permissions and scope with the fixture's. Rows carrying `seedTag`
 * are ours and get re-synced; anything else stops the run with an instruction.
 */
function assertSeeded(
  existing: Record<string, any> | null,
  kind: string,
  label: string,
): void {
  if (existing && existing.seedTag !== SEED_TAG) {
    throw new Error(
      `A ${kind} named "${label}" already exists in this tenant and was not created by this fixture. ` +
        `Rename it (or rename the fixture ${kind} in rbac-demo.blueprint.ts) — refusing to overwrite tenant data.`,
    );
  }
}

async function seedOrgUnits(db: Db, tenantId: string, dryRun: boolean) {
  const idByCode = new Map<string, ObjectId>();
  // Parents before children: `path` is a materialised ancestor path, so a child
  // cannot be written before its parent's id exists.
  const ordered = [...ORG_UNITS].sort((a, b) =>
    a.parentCode === null ? -1 : b.parentCode === null ? 1 : 0,
  );

  for (const spec of ordered) {
    const existing = await db
      .collection('org_units')
      .findOne({ tenantId: new ObjectId(tenantId), code: spec.code });

    if (existing) {
      assertSeeded(existing, 'org unit', `${spec.name} (${spec.code})`);
      idByCode.set(spec.code, existing._id);
      if (!dryRun) {
        await db.collection('org_units').updateOne(
          { _id: existing._id },
          {
            $set: {
              name: spec.name,
              description: spec.description,
              updatedAt: new Date(),
            },
          },
        );
      }
      log(`   ~ org unit ${spec.code} re-synced`);
      continue;
    }

    // `{tenantId, name}` is unique, so a same-named unit under a different code
    // would fail the insert with a driver-level duplicate-key error. Say what to
    // do about it instead.
    const nameClash = await db
      .collection('org_units')
      .findOne({ tenantId: new ObjectId(tenantId), name: spec.name });
    if (nameClash) {
      throw new Error(
        `An org unit named "${spec.name}" already exists under code "${nameClash.code}". ` +
          `Org-unit names are unique per tenant — rename one of them.`,
      );
    }

    const parentId = spec.parentCode ? idByCode.get(spec.parentCode) : null;
    if (spec.parentCode && !parentId) {
      throw new Error(
        `Parent org unit ${spec.parentCode} must be seeded before ${spec.code}`,
      );
    }

    const _id = new ObjectId();
    const parentPath = parentId
      ? ((await db.collection('org_units').findOne({ _id: parentId }))?.path ??
        '/')
      : '/';
    const path = `${parentPath}${_id.toString()}/`;
    const depth = path.split('/').filter(Boolean).length - 1;

    if (!dryRun) {
      await db.collection('org_units').insertOne({
        _id,
        tenantId: new ObjectId(tenantId),
        ...stamp,
        name: spec.name,
        code: spec.code,
        description: spec.description,
        parentId: parentId ?? null,
        path,
        depth,
        managerId: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    idByCode.set(spec.code, _id);
    log(`   + org unit ${spec.code} (depth ${depth})`);
  }

  return idByCode;
}

async function seedRoles(
  db: Db,
  tenantId: string,
  ceiling: Set<string>,
  dryRun: boolean,
) {
  const idByKey = new Map<string, string>();

  for (const spec of ROLES) {
    // A key outside the tenant ceiling would be dropped by the engine at
    // evaluation time; storing it would make the role claim a permission it
    // does not actually confer.
    const permissions = spec.permissions.filter((key) => ceiling.has(key));
    const dropped = spec.permissions.filter((key) => !ceiling.has(key));
    if (dropped.length) {
      log(
        `   ! role ${spec.key}: ${dropped.length} key(s) outside the tenant ceiling dropped (${dropped.join(', ')})`,
      );
    }

    const existing = await db
      .collection('custom_roles')
      .findOne({ tenantId, name: spec.name });

    if (existing) {
      assertSeeded(existing, 'role', spec.name);
      if (!dryRun) {
        await db.collection('custom_roles').updateOne(
          { _id: existing._id },
          {
            $set: {
              ...stamp,
              description: spec.description,
              color: spec.color,
              permissions,
              dataScope: spec.dataScope,
              updatedAt: new Date(),
            },
          },
        );
      }
      idByKey.set(spec.key, existing._id.toString());
      log(
        `   ~ role ${spec.key} re-synced (${permissions.length} perms, scope ${spec.dataScope})`,
      );
      continue;
    }

    const _id = new ObjectId();
    if (!dryRun) {
      await db.collection('custom_roles').insertOne({
        _id,
        tenantId,
        ...stamp,
        name: spec.name,
        description: spec.description,
        color: spec.color,
        permissions,
        dataScope: spec.dataScope,
        isSystem: false,
        systemKey: null,
        templateVersion: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    idByKey.set(spec.key, _id.toString());
    log(
      `   + role ${spec.key} (${permissions.length} perms, scope ${spec.dataScope})`,
    );
  }

  return idByKey;
}

async function seedUsers(
  db: Db,
  kc: KeycloakAdmin,
  tenantId: string,
  keycloakOrgId: string | null,
  roleIdByKey: Map<string, string>,
  orgUnitIdByCode: Map<string, ObjectId>,
  dryRun: boolean,
) {
  const idByEmail = new Map<string, ObjectId>();

  // Pass 1: Keycloak account + Mongo user + membership.
  for (const spec of USERS) {
    let keycloakId: string | null = null;
    if (!dryRun) {
      const existing = await kc.findUserByEmail(spec.email);
      if (existing) {
        keycloakId = existing.id;
        await kc.setPassword(existing.id, DEMO_PASSWORD);
      } else {
        const created = await kc.createUser(
          spec.email,
          spec.fullName,
          DEMO_PASSWORD,
        );
        keycloakId = created.id;
      }
      if (keycloakOrgId && keycloakId) {
        await kc.addUserToOrganization(keycloakOrgId, keycloakId);
      }
    }

    const spaceIdx = spec.fullName.indexOf(' ');
    const firstName =
      spaceIdx > -1 ? spec.fullName.slice(0, spaceIdx) : spec.fullName;
    const lastName = spaceIdx > -1 ? spec.fullName.slice(spaceIdx + 1) : '';
    const orgUnitId = spec.orgUnitCode
      ? (orgUnitIdByCode.get(spec.orgUnitCode) ?? null)
      : null;
    const membership = {
      tenantId: new ObjectId(tenantId),
      roles: spec.tenantRoles,
      roleIds: spec.roleKeys.map((key) => {
        const id = roleIdByKey.get(key);
        if (!id) throw new Error(`Unknown role key "${key}" for ${spec.email}`);
        return id;
      }),
      permissions: [] as string[],
      permissionOverrides: spec.permissionOverrides ?? {},
      joinedAt: new Date(),
    };

    const existingUser = await db
      .collection('users')
      .findOne({ email: spec.email });

    if (existingUser) {
      idByEmail.set(spec.email, existingUser._id);
      if (!dryRun) {
        const others = (existingUser.tenants ?? []).filter(
          (row: any) => String(row.tenantId) !== tenantId,
        );
        await db.collection('users').updateOne(
          { _id: existingUser._id },
          {
            $set: {
              firstName,
              lastName,
              provider: 'email',
              keycloakId,
              platformRole: 'USER',
              status: 'active',
              onboardingStatus: 'COMPLETED',
              orgUnitId,
              tenants: [...others, membership],
              updatedAt: new Date(),
            },
          },
        );
      }
      log(`   ~ user ${spec.email} updated`);
      continue;
    }

    const _id = new ObjectId();
    if (!dryRun) {
      await db.collection('users').insertOne({
        _id,
        email: spec.email,
        firstName,
        lastName,
        provider: 'email',
        keycloakId,
        platformRole: 'USER',
        status: 'active',
        onboardingStatus: 'COMPLETED',
        orgUnitId,
        reportsToId: null, // pass 2
        skills: [],
        tenants: [membership],
        createdAt: new Date(),
        updatedAt: new Date(),
        __v: 0,
      });
    }
    idByEmail.set(spec.email, _id);
    log(`   + user ${spec.email}`);
  }

  // Pass 2: the reportsToId chain, which SUBORDINATES / org-unit scopes walk.
  for (const spec of USERS) {
    if (!spec.reportsToEmail) continue;
    const self = idByEmail.get(spec.email);
    const manager = idByEmail.get(spec.reportsToEmail);
    if (!self || !manager) continue;
    if (!dryRun) {
      await db
        .collection('users')
        .updateOne({ _id: self }, { $set: { reportsToId: manager } });
    }
  }

  // Pass 3: org-unit heads.
  for (const spec of ORG_UNITS) {
    if (!spec.managerEmail) continue;
    const unitId = orgUnitIdByCode.get(spec.code);
    const managerId = idByEmail.get(spec.managerEmail);
    if (!unitId || !managerId || dryRun) continue;
    await db
      .collection('org_units')
      .updateOne({ _id: unitId }, { $set: { managerId } });
  }

  return idByEmail;
}

async function seedGroups(
  db: Db,
  tenantId: string,
  roleIdByKey: Map<string, string>,
  userIdByEmail: Map<string, ObjectId>,
  dryRun: boolean,
) {
  const idByKey = new Map<string, string>();

  for (const spec of GROUPS) {
    const memberIds = spec.memberEmails
      .map((email) => userIdByEmail.get(email))
      .filter((id): id is ObjectId => Boolean(id));
    const roleIds = spec.roleKeys.map((key) => {
      const id = roleIdByKey.get(key);
      if (!id)
        throw new Error(`Unknown role key "${key}" for group ${spec.key}`);
      return id;
    });

    const existing = await db
      .collection('groups')
      .findOne({ tenantId: new ObjectId(tenantId), name: spec.name });

    if (existing) {
      assertSeeded(existing, 'group', spec.name);
      idByKey.set(spec.key, existing._id.toString());
      if (!dryRun) {
        await db.collection('groups').updateOne(
          { _id: existing._id },
          {
            $set: {
              ...stamp,
              description: spec.description,
              memberIds,
              roleIds,
              isActive: true,
              updatedAt: new Date(),
            },
          },
        );
      }
      log(`   ~ group ${spec.key} re-synced (${memberIds.length} members)`);
      continue;
    }

    const _id = new ObjectId();
    if (!dryRun) {
      await db.collection('groups').insertOne({
        _id,
        tenantId: new ObjectId(tenantId),
        ...stamp,
        name: spec.name,
        description: spec.description,
        parentGroupId: null,
        memberIds,
        permissions: [],
        roleIds,
        isActive: true,
        color: '#6366f1',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    idByKey.set(spec.key, _id.toString());
    log(`   + group ${spec.key} (${memberIds.length} members)`);
  }

  return idByKey;
}

async function seedJitGrants(
  db: Db,
  tenantId: string,
  roleIdByKey: Map<string, string>,
  userIdByEmail: Map<string, ObjectId>,
  grantedById: ObjectId,
  dryRun: boolean,
) {
  for (const spec of USERS) {
    if (!spec.jitGrant) continue;
    const principalId = userIdByEmail.get(spec.email);
    const roleId = roleIdByKey.get(spec.jitGrant.roleKey);
    if (!principalId || !roleId) continue;

    const expiresAt = new Date(
      Date.now() + spec.jitGrant.hours * 60 * 60 * 1000,
    );
    const filter = {
      tenantId,
      principalType: 'user',
      principalId: principalId.toString(),
      roleId,
    };
    if (!dryRun) {
      await db.collection('role_assignments').updateOne(
        filter,
        {
          $set: {
            ...stamp,
            expiresAt,
            reason: spec.jitGrant.reason,
            revokedAt: null,
            revokedById: null,
            grantedById: grantedById.toString(),
            updatedAt: new Date(),
          },
          $setOnInsert: { ...filter, createdAt: new Date() },
        },
        { upsert: true },
      );
    }
    log(
      `   + JIT grant ${spec.email} → ${spec.jitGrant.roleKey} (${
        spec.jitGrant.hours >= 0 ? 'active' : 'ALREADY EXPIRED'
      }, expires ${expiresAt.toISOString()})`,
    );
  }
}

async function seedContacts(
  db: Db,
  tenantId: string,
  userIdByEmail: Map<string, ObjectId>,
  orgUnitIdByCode: Map<string, ObjectId>,
  createdById: ObjectId,
  dryRun: boolean,
) {
  const idByKey = new Map<string, string>();

  for (const spec of CONTACTS) {
    const ownerId = spec.ownerEmail
      ? (userIdByEmail.get(spec.ownerEmail) ?? null)
      : null;
    const orgUnitId = spec.orgUnitCode
      ? (orgUnitIdByCode.get(spec.orgUnitCode) ?? null)
      : null;

    // Matched on the contact's email, not the display name: the names are real
    // Vietnamese names that a reviewer may well want to change, and a lookup
    // keyed on them would turn a rename into a duplicate row. The tags are no
    // help either now that they are ordinary CRM tags a user may edit.
    const existing = await db.collection('contacts').findOne({
      tenantId: new ObjectId(tenantId),
      emails: spec.email,
    });

    if (existing) {
      assertSeeded(existing, 'contact', spec.email);
      idByKey.set(spec.key, existing._id.toString());
      if (!dryRun) {
        await db.collection('contacts').updateOne(
          { _id: existing._id },
          {
            $set: {
              ...stamp,
              firstName: spec.firstName,
              lastName: spec.lastName,
              title: spec.title,
              companyName: spec.companyName,
              ownerId,
              orgUnitId,
              tags: spec.tags,
              updatedAt: new Date(),
            },
          },
        );
      }
      log(`   ~ contact ${spec.key} re-synced`);
      continue;
    }

    const _id = new ObjectId();
    if (!dryRun) {
      await db.collection('contacts').insertOne({
        _id,
        tenantId: new ObjectId(tenantId),
        ...stamp,
        firstName: spec.firstName,
        lastName: spec.lastName,
        title: spec.title,
        companyName: spec.companyName,
        emails: [spec.email],
        phones: [],
        tags: spec.tags,
        ownerId,
        orgUnitId,
        createdById,
        updatedById: createdById,
        score: 0,
        emailOptIn: false,
        smsOptIn: false,
        doNotCall: false,
        omniIdentities: [],
        isShadow: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        __v: 0,
      });
    }
    idByKey.set(spec.key, _id.toString());
    log(`   + contact ${spec.key} (owner ${spec.ownerEmail ?? 'NONE'})`);
  }

  return idByKey;
}

async function seedPolicies(
  db: Db,
  tenantId: string,
  groupIdByKey: Map<string, string>,
  userIdByEmail: Map<string, ObjectId>,
  dryRun: boolean,
) {
  const resolvePlaceholder = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    const group = value.match(/^\{\{groupId:(.+)\}\}$/);
    if (group) {
      const id = groupIdByKey.get(group[1]);
      if (!id) throw new Error(`Unknown group key "${group[1]}" in policy`);
      return id;
    }
    const user = value.match(/^\{\{userId:(.+)\}\}$/);
    if (user) {
      const id = userIdByEmail.get(user[1]);
      if (!id) throw new Error(`Unknown user "${user[1]}" in policy`);
      return id.toString();
    }
    return value;
  };

  for (const spec of POLICIES) {
    const conditions = spec.conditions.map((condition) => ({
      ...condition,
      ...(condition.value !== undefined
        ? { value: resolvePlaceholder(condition.value) }
        : {}),
    }));

    const doc = {
      tenantId,
      ...stamp,
      name: spec.name,
      description: spec.description,
      resource: spec.resource,
      action: spec.action,
      effect: spec.effect,
      conditions,
      active: true,
      priority: spec.priority,
      updatedAt: new Date(),
    };

    if (!dryRun) {
      await db
        .collection('access_policies')
        .updateOne(
          { tenantId, name: spec.name },
          { $set: doc, $setOnInsert: { createdAt: new Date() } },
          { upsert: true },
        );
    }
    log(
      `   + policy [${spec.effect}] ${spec.resource}:${spec.action} — ${spec.name}`,
    );
  }
}

async function seedAcls(
  db: Db,
  tenantId: string,
  contactIdByKey: Map<string, string>,
  groupIdByKey: Map<string, string>,
  userIdByEmail: Map<string, ObjectId>,
  dryRun: boolean,
) {
  for (const spec of ACLS) {
    const resourceId = contactIdByKey.get(spec.contactKey);
    if (!resourceId)
      throw new Error(`Unknown contact key "${spec.contactKey}"`);

    const principalId =
      spec.principalType === 'user'
        ? userIdByEmail.get(spec.principalRef)?.toString()
        : groupIdByKey.get(spec.principalRef);
    if (!principalId) {
      throw new Error(`Unknown ACL principal "${spec.principalRef}"`);
    }

    const filter = {
      tenantId,
      resourceType: 'contacts',
      resourceId,
      principalType: spec.principalType,
      principalId,
    };
    if (!dryRun) {
      await db.collection('object_acl').updateOne(
        filter,
        {
          $set: {
            ...stamp,
            permissions: spec.permissions,
            isDeny: spec.isDeny,
            updatedAt: new Date(),
          },
          $setOnInsert: { ...filter, createdAt: new Date() },
        },
        { upsert: true },
      );
    }
    log(
      `   + ACL ${spec.isDeny ? 'DENY' : 'ALLOW'} ${spec.permissions.join('/')} on ${spec.contactKey} for ${spec.principalType} ${spec.principalRef}`,
    );
  }
}

/**
 * Force the tenant default scope to SELF.
 *
 * The shipped default is SUBORDINATES, which is unioned with every role's own
 * scope — so a SELF role would still see its reports' records and the fixture
 * could not show SELF and ORG_UNIT behaving differently.
 */
async function setDataVisibilitySettings(
  db: Db,
  tenantId: string,
  dryRun: boolean,
) {
  const existing = await db
    .collection('crm_settings')
    .findOne({ tenantId: new ObjectId(tenantId), key: 'data_visibility' });

  const value = {
    ...(existing?.value ?? {}),
    defaultAccess: 'private',
    defaultScope: 'self',
    unownedRecordsVisibleToAll: false,
    moduleOverrides: existing?.value?.moduleOverrides ?? {},
  };

  if (!dryRun) {
    await db.collection('crm_settings').updateOne(
      { tenantId: new ObjectId(tenantId), key: 'data_visibility' },
      {
        $set: { value, updatedAt: new Date() },
        $setOnInsert: {
          tenantId: new ObjectId(tenantId),
          key: 'data_visibility',
          createdAt: new Date(),
          __v: 0,
        },
      },
      { upsert: true },
    );
  }
  log(`   + data_visibility = ${JSON.stringify(value)}`);
}

/**
 * Drop the caches that hold pre-seed authorization answers.
 *
 * Without this the API keeps serving the effective-permission set, the verified
 * tenant membership and the Keycloak-id mapping it computed before these rows
 * existed, and the first verification run reads as a broken fixture.
 */
async function invalidateCaches(tenantId: string, dryRun: boolean) {
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_CACHE_DB ?? process.env.REDIS_DB ?? 0),
    maxRetriesPerRequest: null,
  });

  try {
    const patterns = [
      `authz:t:${tenantId}:u:*`,
      `tenant:member:v2:${tenantId}:*`,
      'user:keycloak:*',
      'user:i18n:*',
    ];
    let removed = 0;
    for (const pattern of patterns) {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          500,
        );
        cursor = next;
        if (keys.length && !dryRun) {
          await redis.del(...keys);
        }
        removed += keys.length;
      } while (cursor !== '0');
    }
    log(`   + invalidated ${removed} cached authorization key(s)`);
  } finally {
    redis.disconnect();
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const { dryRun, reset, purge: purgeOnly } = parseArgs();

  if (process.env.NODE_ENV === REFUSE_IN_PRODUCTION) {
    console.error(
      'Refusing to run: this fixture creates shared-password logins and is for local/dev only.',
    );
    process.exit(1);
  }

  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const kc = new KeycloakAdmin(
    process.env.KEYCLOAK_AUTH_SERVER_URL ?? 'http://localhost:8080',
    process.env.KEYCLOAK_REALM ?? 'crm-saas',
    process.env.KEYCLOAK_ADMIN_CLIENT_ID ?? 'crm-api-admin',
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET ?? '',
  );

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    log(
      `✅ Connected to MongoDB${dryRun ? ' (DRY RUN — nothing is written)' : ''}`,
    );

    await kc.authenticate();
    log(
      `✅ Authenticated against Keycloak realm "${process.env.KEYCLOAK_REALM ?? 'crm-saas'}"\n`,
    );

    const tenant = await resolveTenant(db);
    const tenantId = tenant._id.toString();
    log(`Tenant "${tenant.alias}" → ${tenantId}\n`);

    if (reset || purgeOnly) {
      await purge(db, kc, tenantId, dryRun);
    }
    await purgeLegacy(db, kc, tenantId, dryRun);
    if (purgeOnly) {
      await invalidateCaches(tenantId, dryRun);
      log('\nPurge complete.');
      return;
    }
    if (reset) log('');

    // The ceiling roles are clamped to — mirrors getTenantPermissions().
    const { CORE_PERMISSIONS } = await import(
      '../../common/permissions/permission.constants'
    );
    const disabled = new Set<string>(tenant.disabledCorePermissions ?? []);
    const ceiling = new Set<string>(
      CORE_PERMISSIONS.filter((key: string) => !disabled.has(key)),
    );
    for (const key of tenant.availablePermissions ?? []) ceiling.add(key);

    const keycloakOrgId =
      tenant.keycloakOrgId ?? (await kc.findOrganizationId(tenant.alias));

    log('Settings');
    await setDataVisibilitySettings(db, tenantId, dryRun);

    log('\nOrg units');
    const orgUnitIdByCode = await seedOrgUnits(db, tenantId, dryRun);

    log('\nCustom roles');
    const roleIdByKey = await seedRoles(db, tenantId, ceiling, dryRun);

    log('\nUsers');
    const userIdByEmail = await seedUsers(
      db,
      kc,
      tenantId,
      keycloakOrgId,
      roleIdByKey,
      orgUnitIdByCode,
      dryRun,
    );

    log('\nGroups');
    const groupIdByKey = await seedGroups(
      db,
      tenantId,
      roleIdByKey,
      userIdByEmail,
      dryRun,
    );

    // Grants are attributed to the tenant owner: role_assignments.grantedById is
    // required, and the owner is the only principal guaranteed to exist.
    const grantedById = tenant.ownerId
      ? new ObjectId(String(tenant.ownerId))
      : (userIdByEmail.get(EMAIL.admin) as ObjectId);

    log('\nTime-boxed (JIT) grants');
    await seedJitGrants(
      db,
      tenantId,
      roleIdByKey,
      userIdByEmail,
      grantedById,
      dryRun,
    );

    log('\nContacts (the rows data scope is measured on)');
    const contactIdByKey = await seedContacts(
      db,
      tenantId,
      userIdByEmail,
      orgUnitIdByCode,
      grantedById,
      dryRun,
    );

    log('\nABAC policies');
    await seedPolicies(db, tenantId, groupIdByKey, userIdByEmail, dryRun);

    log('\nObject ACL entries');
    await seedAcls(
      db,
      tenantId,
      contactIdByKey,
      groupIdByKey,
      userIdByEmail,
      dryRun,
    );

    log('\nCache invalidation');
    await invalidateCaches(tenantId, dryRun);

    log('\n=== Accounts ===');
    log(`  password for every account: ${DEMO_PASSWORD}`);
    for (const spec of USERS) {
      log(`  ${spec.email.padEnd(38)} ${spec.purpose}`);
    }

    log(
      dryRun
        ? '\nDRY RUN — nothing was written.'
        : '\nDone. Verify with: npm run verify:rbac-demo',
    );
  } catch (error: any) {
    console.error(
      'Seeding failed:',
      error?.response?.data
        ? JSON.stringify(error.response.data)
        : error instanceof Error
          ? error.message
          : error,
    );
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

void run();
