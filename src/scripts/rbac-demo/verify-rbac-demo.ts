import 'dotenv/config';
import axios, { AxiosInstance } from 'axios';
import { MongoClient, ObjectId } from 'mongodb';

import {
  CONTACTS,
  DEMO_PASSWORD,
  DEMO_TENANT_ALIAS,
  EXPECTATIONS,
  RECORD_PROBES,
  ROUTE_PROBES,
  SEED_TAG,
  USERS,
} from './rbac-demo.blueprint';

/**
 * Verifies the seeded RBAC / ABAC fixture against the RUNNING API — the only
 * check that proves the guards, interceptors and repositories agree with the
 * data. A unit test can assert the engine; only a real request can assert the
 * whole chain (token → tenant → membership → RBAC → data scope → ACL → ABAC).
 *
 * Usage (with the API running on http://localhost:3000):
 *   npm run verify:rbac-demo
 *
 * Every account logs in with the Keycloak direct-grant flow, then:
 *   1. GET /me/permissions       → data scope, fullAccess, individual keys
 *   2. GET /contacts             → the exact set of rows the scope should expose
 *   3. PATCH /contacts/:id       → record-level probes (object-ACL, ABAC, scope)
 *   4. GET <module>              → resource-level RBAC probes
 *
 * The tenant is carried by a Host header (`master.crm.localhost`) rather than
 * DNS, so no hosts-file entry is needed — TenantResolverMiddleware reads the
 * subdomain straight off that header.
 */

const API_ORIGIN = process.env.RBAC_DEMO_API ?? 'http://127.0.0.1:3000';
const API_PREFIX = process.env.RBAC_DEMO_API_PREFIX ?? '/api/v1';
const ROOT_DOMAIN = process.env.APP_ROOT_DOMAIN ?? 'crm.localhost';
const TENANT_HOST = `${DEMO_TENANT_ALIAS}.${ROOT_DOMAIN}`;

interface Failure {
  account: string;
  check: string;
  expected: string;
  actual: string;
}

const failures: Failure[] = [];
const passes: string[] = [];

const ok = (account: string, check: string) => {
  passes.push(`${account} · ${check}`);
  console.log(`   ✅ ${check}`);
};

const fail = (
  account: string,
  check: string,
  expected: unknown,
  actual: unknown,
) => {
  failures.push({
    account,
    check,
    expected: String(expected),
    actual: String(actual),
  });
  console.log(`   ❌ ${check} — expected ${expected}, got ${actual}`);
};

// ── Auth ────────────────────────────────────────────────────────────────────

async function login(email: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: process.env.KEYCLOAK_CLIENT_ID ?? 'crm-api',
    client_secret: process.env.KEYCLOAK_CLIENT_SECRET ?? '',
    username: email,
    password: DEMO_PASSWORD,
    scope: 'openid',
  });
  const url = `${process.env.KEYCLOAK_AUTH_SERVER_URL ?? 'http://localhost:8080'}/realms/${
    process.env.KEYCLOAK_REALM ?? 'crm-saas'
  }/protocol/openid-connect/token`;
  const { data } = await axios.post(url, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return data.access_token;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry on 429 rather than reporting it as a permission result.
 *
 * The harness fires ~100 requests from 11 accounts in a few seconds and trips
 * the global throttler; a rate-limited response says nothing about
 * authorization, so treating it as a verdict produces phantom failures.
 */
function withThrottleRetry(client: AxiosInstance): AxiosInstance {
  client.interceptors.response.use(async (response) => {
    let attempts = 0;
    let current = response;
    while (current.status === 429 && attempts < 5) {
      attempts++;
      const retryAfter = Number(current.headers?.['retry-after'] ?? 1);
      await sleep(Math.max(retryAfter, 1) * 1000);
      current = await client.request(current.config);
    }
    return current;
  });
  return client;
}

function apiClient(token: string): AxiosInstance {
  return withThrottleRetry(
    axios.create({
      baseURL: `${API_ORIGIN}${API_PREFIX}`,
      headers: {
        Authorization: `Bearer ${token}`,
        // Tenant resolution: the middleware reads the subdomain from Host.
        Host: TENANT_HOST,
      },
      // Every status is data here — a 403 is a result, not an exception.
      validateStatus: () => true,
    } as any),
  );
}

// ── Fixture id lookup ───────────────────────────────────────────────────────

async function loadFixtureIds() {
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error('DATABASE_URL is required');
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db();
    const tenant = await db
      .collection('tenants')
      .findOne({ alias: DEMO_TENANT_ALIAS });
    if (!tenant) throw new Error(`Tenant "${DEMO_TENANT_ALIAS}" not found`);

    const contactDocs = await db
      .collection('contacts')
      .find({ tenantId: new ObjectId(tenant._id), seedTag: SEED_TAG })
      .project({ emails: 1 })
      .toArray();

    const idByKey = new Map<string, string>();
    const keyById = new Map<string, string>();
    for (const spec of CONTACTS) {
      // Keyed on the contact's email — display names may change.
      const doc = contactDocs.find((row) =>
        (row.emails ?? []).includes(spec.email),
      );
      if (!doc) {
        throw new Error(
          `Contact fixture "${spec.key}" is missing. Run \`npm run seed:rbac-demo\` first.`,
        );
      }
      idByKey.set(spec.key, doc._id.toString());
      keyById.set(doc._id.toString(), spec.key);
    }
    return { tenantId: tenant._id.toString(), idByKey, keyById };
  } finally {
    await client.close();
  }
}

// ── Checks ──────────────────────────────────────────────────────────────────

async function checkAccount(
  email: string,
  client: AxiosInstance,
  keyById: Map<string, string>,
) {
  const expectation = EXPECTATIONS.find((row) => row.email === email);
  if (!expectation) return;

  // 1. Effective permissions, data scope, full-access flag.
  const me = await client.get('/me/permissions');
  if (me.status !== 200) {
    fail(email, 'GET /me/permissions', 200, me.status);
    return;
  }

  const { permissions = [], dataScope, fullAccess } = me.data ?? {};
  const held = new Set<string>(permissions);

  if (dataScope === expectation.dataScope) {
    ok(email, `data scope = ${dataScope}`);
  } else {
    fail(email, 'data scope', expectation.dataScope, dataScope);
  }

  if (Boolean(fullAccess) === expectation.fullAccess) {
    ok(email, `fullAccess = ${Boolean(fullAccess)}`);
  } else {
    fail(email, 'fullAccess', expectation.fullAccess, Boolean(fullAccess));
  }

  for (const [key, shouldHold] of Object.entries(expectation.permissions)) {
    if (held.has(key) === shouldHold) {
      ok(email, `${shouldHold ? 'holds' : 'lacks'} ${key}`);
    } else {
      fail(email, `permission ${key}`, shouldHold, held.has(key));
    }
  }

  // 2. Row visibility on the list endpoint.
  const list = await client.get('/contacts?limit=200');
  if (expectation.visibleContacts === null) {
    if (list.status === 403) {
      ok(email, 'GET /contacts rejected (no contacts:view)');
    } else {
      fail(email, 'GET /contacts', 403, list.status);
    }
    return;
  }

  if (list.status !== 200) {
    fail(email, 'GET /contacts', 200, list.status);
    return;
  }

  const rows: any[] = list.data?.data ?? list.data?.items ?? list.data ?? [];
  const seen = new Set(
    (Array.isArray(rows) ? rows : [])
      .map((row) => keyById.get(String(row.id ?? row._id)))
      .filter((key): key is string => Boolean(key)),
  );
  const expected = new Set(expectation.visibleContacts);
  const missing = [...expected].filter((key) => !seen.has(key));
  const extra = [...seen].filter((key) => !expected.has(key));

  if (!missing.length && !extra.length) {
    ok(email, `sees exactly ${expected.size} demo contact(s)`);
  } else {
    fail(
      email,
      'visible fixture contacts',
      [...expected].sort().join(',') || '(none)',
      `${[...seen].sort().join(',') || '(none)'}${
        missing.length ? ` [missing ${missing.join(',')}]` : ''
      }${extra.length ? ` [unexpected ${extra.join(',')}]` : ''}`,
    );
  }
}

async function runRecordProbes(
  clients: Map<string, AxiosInstance>,
  idByKey: Map<string, string>,
) {
  console.log('\n── Record-level probes (PATCH /contacts/:id) ──');
  for (const probe of RECORD_PROBES) {
    const client = clients.get(probe.email);
    if (!client) continue;
    const id = idByKey.get(probe.contactKey);
    // Written into customFields rather than a real column: a probe must not
    // leave "rbac-probe object-acl" sitting in the Job title of a demo contact
    // that someone is about to look at in the UI.
    const response = await client.patch(`/contacts/${id}`, {
      customFields: { rbacProbe: probe.layer },
    });
    const label = `[${probe.layer}] ${probe.label}`;
    const bodyIsEmpty =
      response.data === '' ||
      response.data === null ||
      response.data === undefined;

    if (response.status !== probe.expectedStatus) {
      fail(probe.email, label, probe.expectedStatus, response.status);
    } else if (probe.expectEmptyBody && !bodyIsEmpty) {
      fail(
        probe.email,
        label,
        '200 with no record returned',
        `200 with a record body (${JSON.stringify(response.data).slice(0, 80)})`,
      );
    } else {
      ok(probe.email, label);
    }
  }
}

async function runRouteProbes(clients: Map<string, AxiosInstance>) {
  console.log('\n── Module-level probes (resource RBAC) ──');
  for (const probe of ROUTE_PROBES) {
    const client = clients.get(probe.email);
    if (!client) continue;
    const response = await client.get(probe.path);
    if (response.status === probe.expectedStatus) {
      ok(probe.email, probe.label);
    } else {
      fail(probe.email, probe.label, probe.expectedStatus, response.status);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function run() {
  console.log(
    `Verifying RBAC/ABAC fixture against ${API_ORIGIN}${API_PREFIX} (Host: ${TENANT_HOST})\n`,
  );

  const { idByKey, keyById } = await loadFixtureIds();

  const clients = new Map<string, AxiosInstance>();
  for (const spec of USERS) {
    try {
      clients.set(spec.email, apiClient(await login(spec.email)));
    } catch (error: any) {
      fail(
        spec.email,
        'Keycloak login',
        'access token',
        error?.response?.data?.error_description ??
          error?.response?.data?.error ??
          error?.message,
      );
    }
  }

  for (const spec of USERS) {
    const client = clients.get(spec.email);
    if (!client) continue;
    console.log(`\n── ${spec.email} ──`);
    console.log(`   ${spec.purpose}`);
    await checkAccount(spec.email, client, keyById);
  }

  await runRecordProbes(clients, idByKey);
  await runRouteProbes(clients);

  console.log('\n=== Summary ===');
  console.log(`  checks passed: ${passes.length}`);
  console.log(`  checks failed: ${failures.length}`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const item of failures) {
      console.log(
        `  · ${item.account} — ${item.check}: expected ${item.expected}, got ${item.actual}`,
      );
    }
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(
    'Verification aborted:',
    error?.response?.data
      ? JSON.stringify(error.response.data)
      : error instanceof Error
        ? error.message
        : error,
  );
  process.exit(1);
});
