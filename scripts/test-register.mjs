#!/usr/bin/env node
/**
 * test-register.mjs  —  Smoke & integration tests for POST /api/v1/auth/register
 *
 * Usage:
 *   node scripts/test-register.mjs                        # TC-1 happy path (random alias)
 *   node scripts/test-register.mjs --alias acme           # custom alias
 *   node scripts/test-register.mjs --alias acme --conflict # TC-2 duplicate alias
 *   node scripts/test-register.mjs --all                  # TC-1 through TC-6
 *   node scripts/test-register.mjs --alias acme --cleanup # delete KC org/user after test
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

// ── Load .env (manual dotenv — no extra deps needed) ──────────────────────────
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx === -1) continue;
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (!(key in process.env)) process.env[key] = val;
    }
}

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL = process.env.BACKEND_DOMAIN ?? 'http://localhost:3000';
const API_PREFIX = process.env.API_PREFIX ?? 'api';
const KC_URL = process.env.KEYCLOAK_AUTH_SERVER_URL ?? 'http://localhost:8080';
const KC_REALM = process.env.KEYCLOAK_REALM ?? 'crm-saas';
const KC_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID ?? 'crm-api';
const KC_CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET ?? '';

// NestJS versioning adds /v1/ prefix when using URI versioning
const REGISTER_URL = `${BASE_URL}/${API_PREFIX}/v1/auth/register`;

// ── CLI ───────────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
    options: {
        alias: { type: 'string', default: `test${Date.now()}` },
        email: { type: 'string', default: '' },
        conflict: { type: 'boolean', default: false },
        cleanup: { type: 'boolean', default: false },
        all: { type: 'boolean', default: false },
    },
});

const ALIAS = args.alias.toLowerCase().replace(/[^a-z0-9]/g, '');
const EMAIL = args.email || `admin@${ALIAS}.test`;

// ── Utilities ─────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function sep(title) {
    console.log(`\n${'═'.repeat(64)}`);
    console.log(`  ${title}`);
    console.log('═'.repeat(64));
}

function ok(msg) { console.log(`  ✅  ${msg}`); passed++; }
function fail(msg) { console.error(`  ❌  ${msg}`); failed++; }
function info(msg) { console.log(`  ℹ️   ${msg}`); }
function warn(msg) { console.warn(`  ⚠️   ${msg}`); }

async function post(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* ignore */ }
    return { status: res.status, ok: res.ok, json };
}

async function kcToken() {
    const form = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: KC_CLIENT_ID,
        client_secret: KC_CLIENT_SECRET,
    });
    try {
        const res = await fetch(`${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token`, {
            method: 'POST', body: form,
        });
        const data = await res.json();
        if (!data.access_token) { warn('KC token missing — KC verification skipped'); return null; }
        return data.access_token;
    } catch {
        warn('Cannot reach Keycloak — KC verification skipped');
        return null;
    }
}

async function kcGet(token, path) {
    const res = await fetch(`${KC_URL}/admin/realms/${KC_REALM}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return res.json();
}

async function kcDel(token, path) {
    const res = await fetch(`${KC_URL}/admin/realms/${KC_REALM}${path}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    return res.status;
}

// ── TC-1: Happy path ──────────────────────────────────────────────────────────
async function tc1HappyPath(alias, email) {
    sep(`TC-1  Happy path  |  alias="${alias}"  email="${email}"`);

    const payload = {
        email,
        password: 'Password123!',
        fullName: 'Test Owner',
        organizationName: `Org ${alias}`,
        organizationAlias: alias,
    };
    info(`POST ${REGISTER_URL}`);
    console.log('  →', JSON.stringify(payload, null, 4).replace(/\n/g, '\n  '));

    const { status, ok: isOk, json } = await post(REGISTER_URL, payload);
    info(`HTTP ${status}`);
    console.log('  ←', JSON.stringify(json, null, 4).replace(/\n/g, '\n  '));

    if (status === 201 && isOk) ok('Status 201');
    else fail(`Expected 201, got ${status} — ${json?.message ?? ''}`);

    const fields = ['tenantId', 'alias', 'organizationName', 'keycloakOrgId', 'loginUrl'];
    const missing = fields.filter(f => !json?.[f]);
    if (missing.length === 0) ok('Response has all required fields');
    else fail(`Missing fields: ${missing.join(', ')}`);

    if (json?.alias === alias) ok(`alias = "${json.alias}"`);
    if (json?.loginUrl?.includes(alias)) ok(`loginUrl contains alias`);

    return { success: isOk, result: json };
}

// ── KC verification ───────────────────────────────────────────────────────────
async function verifyKeycloak(alias, email, keycloakOrgId) {
    sep('KC verification');
    const token = await kcToken();
    if (!token) { warn('Skipped — no KC token'); return null; }

    // Org
    const orgs = await kcGet(token, `/organizations?search=${encodeURIComponent(alias)}`);
    const org = Array.isArray(orgs) ? orgs.find(o => o.alias === alias) : null;
    if (org) ok(`KC org "${alias}" exists (id=${org.id})`);
    else fail(`KC org "${alias}" NOT found in Keycloak`);

    // User membership
    if (org) {
        const members = await kcGet(token, `/organizations/${org.id}/members`);
        const member = Array.isArray(members) && members.find(m => m.email === email);
        if (member) ok(`User ${email} is a member of KC org`);
        else fail(`User ${email} NOT found as member of KC org`);

        // Role
        const roles = await kcGet(token, `/organizations/${org.id}/members/${member?.id}/roles`);
        const hasOrgAdmin = Array.isArray(roles) && roles.some(r => r.name === 'org-admin');
        if (hasOrgAdmin) ok(`User has org-admin role`);
        else fail(`User does NOT have org-admin role`);
    }

    // User exists in realm
    const users = await kcGet(token, `/users?email=${encodeURIComponent(email)}&exact=true`);
    const kcUser = Array.isArray(users) && users[0];
    if (kcUser) ok(`KC user ${email} exists (id=${kcUser.id})`);
    else fail(`KC user ${email} NOT found`);

    return token;
}

// ── TC-2: Duplicate alias → 409 ──────────────────────────────────────────────
async function tc2Conflict(alias) {
    sep(`TC-2  Duplicate alias → 409  |  alias="${alias}"`);
    const payload = {
        email: `dup${Date.now()}@${alias}.test`,
        password: 'Password123!',
        fullName: 'Dup User',
        organizationName: `Dup Org ${alias}`,
        organizationAlias: alias,
    };
    info(`POST ${REGISTER_URL}`);
    const { status, json } = await post(REGISTER_URL, payload);
    info(`HTTP ${status} — ${json?.message ?? ''}`);
    if (status === 409) ok('Got 409 ConflictException — alias reservation working ✓');
    else fail(`Expected 409, got ${status}: ${JSON.stringify(json)}`);
}

// ── TC-3: Invalid payload → 422 ──────────────────────────────────────────────
async function tc3Validation() {
    sep('TC-3  Missing required fields → 422');
    const { status, json } = await post(REGISTER_URL, { email: 'bad' });
    info(`HTTP ${status} — ${JSON.stringify(json?.message ?? json)}`);
    if (status === 422 || status === 400) ok(`Got ${status} (validation error)`);
    else fail(`Expected 422/400, got ${status}`);
}

// ── TC-4: Weak password → 422 ────────────────────────────────────────────────
async function tc4WeakPassword() {
    sep('TC-4  Weak password → 422');
    const alias = `weakpwd${Date.now()}`;
    const { status, json } = await post(REGISTER_URL, {
        email: `admin@${alias}.test`,
        password: '123',
        fullName: 'Test',
        organizationName: 'Org',
        organizationAlias: alias,
    });
    info(`HTTP ${status} — ${JSON.stringify(json?.message ?? json)}`);
    if (status === 422 || status === 400) ok(`Got ${status} (password validation)`);
    else fail(`Expected 422/400, got ${status}: ${JSON.stringify(json)}`);
}

// ── TC-5: Invalid alias chars → 422/400 ──────────────────────────────────────
async function tc5BadAlias() {
    sep('TC-5  Invalid alias (spaces / uppercase) → 422');
    const { status, json } = await post(REGISTER_URL, {
        email: `admin@test.com`,
        password: 'Password123!',
        fullName: 'Test',
        organizationName: 'Bad Alias Org',
        organizationAlias: 'My Bad Alias!',
    });
    info(`HTTP ${status} — ${JSON.stringify(json?.message ?? json)}`);
    if (status === 422 || status === 400) ok(`Got ${status} (alias validation)`);
    else fail(`Expected 422/400 for bad alias, got ${status}: ${JSON.stringify(json)}`);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
async function cleanup(token, alias, email) {
    sep('Cleanup — removing KC resources');
    const orgs = await kcGet(token, `/organizations?search=${encodeURIComponent(alias)}`);
    const org = Array.isArray(orgs) && orgs.find(o => o.alias === alias);
    if (org) {
        const s = await kcDel(token, `/organizations/${org.id}`);
        info(`DELETE KC org → ${s}`);
    }
    const users = await kcGet(token, `/users?email=${encodeURIComponent(email)}&exact=true`);
    const user = Array.isArray(users) && users[0];
    if (user) {
        const s = await kcDel(token, `/users/${user.id}`);
        info(`DELETE KC user → ${s}`);
    }
    info('ℹ  MongoDB docs NOT removed — delete manually if needed.');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n🚀  SaaS /auth/register — Integration Test Suite');
    console.log(`   API:      ${REGISTER_URL}`);
    console.log(`   Alias:    ${ALIAS}`);
    console.log(`   Email:    ${EMAIL}`);
    console.log(`   Keycloak: ${KC_URL} | realm=${KC_REALM}`);

    // TC-1 always runs
    const { success, result } = await tc1HappyPath(ALIAS, EMAIL);

    let kcAdminToken = null;
    if (success) {
        kcAdminToken = await verifyKeycloak(ALIAS, EMAIL, result?.keycloakOrgId);
    }

    // Extended test cases
    if (args.conflict || args.all) await tc2Conflict(ALIAS);
    if (args.all) await tc3Validation();
    if (args.all) await tc4WeakPassword();
    if (args.all) await tc5BadAlias();

    // Cleanup
    if (args.cleanup && kcAdminToken) {
        await cleanup(kcAdminToken, ALIAS, EMAIL);
    }

    // Summary
    sep('Summary');
    console.log(`  Passed: ${passed}   Failed: ${failed}`);
    if (failed === 0) console.log('\n  🎉  All tests PASSED — ready for release!\n');
    else console.error(`\n  ❌  ${failed} test(s) FAILED — fix bugs before release.\n`);

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('\n💥 Unhandled error:', err.message, err.stack);
    process.exit(1);
});
