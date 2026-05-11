#!/usr/bin/env node
/**
 * Smoke test for the PLG onboarding flow.
 *
 * Examples:
 *   node scripts/test-onboarding.mjs
 *   node scripts/test-onboarding.mjs --base-url https://api.crmsaudi.dev/api/v1
 *   node scripts/test-onboarding.mjs --email test@example.com --complete
 *
 * The script stops before POST /onboarding/complete unless --complete is set.
 * That keeps production checks from accidentally creating a real tenant.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

loadDotEnv();

const { values: args } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    email: { type: 'string' },
    password: { type: 'string', default: 'Password123!' },
    'full-name': { type: 'string', default: 'Onboarding Tester' },
    company: { type: 'string' },
    complete: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
  },
});

const baseUrl = normalizeBaseUrl(
  args['base-url'] ||
    process.env.ONBOARDING_API_BASE_URL ||
    buildBaseUrlFromEnv() ||
    'http://localhost:3000/api/v1',
);

const stamp = new Date()
  .toISOString()
  .replace(/[-:.TZ]/g, '')
  .slice(0, 14);

const payload = {
  email: args.email || `onboarding.${stamp}@example.com`,
  fullName: args['full-name'],
  password: args.password,
};

const companyName = args.company || `Onboarding Test ${stamp}`;
const cookieJar = new Map();

const state = {
  start: null,
  context: null,
  updateCompany: null,
  updateUseCase: null,
  complete: null,
  status: null,
};

await main();

async function main() {
  printHeader();

  state.start = await request('POST', '/onboarding/start', payload, {
    expected: [201],
  });
  assertStep(state.start, 'start');

  state.context = await request('GET', '/onboarding/context', undefined, {
    expected: [200],
  });
  assertStep(state.context, 'context');

  state.updateCompany = await request(
    'PATCH',
    '/onboarding/context',
    {
      companyName,
      teamSize: '11-50',
    },
    { expected: [200] },
  );
  assertStep(state.updateCompany, 'update company/team size');

  state.updateUseCase = await request(
    'PATCH',
    '/onboarding/context',
    {
      useCase: 'sales_pipeline',
    },
    { expected: [200] },
  );
  assertStep(state.updateUseCase, 'update use case');

  if (!args.complete) {
    console.log('\nOK: onboarding start/context flow passed.');
    console.log(
      'Skipped POST /onboarding/complete. Pass --complete to queue provisioning.',
    );
    return;
  }

  state.complete = await request('POST', '/onboarding/complete', undefined, {
    expected: [202],
  });
  assertStep(state.complete, 'complete');

  const provisioningId = state.complete.body?.provisioningId;
  if (!provisioningId) {
    fail('complete response did not include provisioningId', state.complete);
  }

  state.status = await request(
    'GET',
    `/onboarding/status/${provisioningId}`,
    undefined,
    {
      expected: [200],
    },
  );
  assertStep(state.status, 'status');

  console.log('\nOK: onboarding complete flow passed.');
}

async function request(method, path, body, { expected }) {
  const url = `${baseUrl}${path}`;
  const headers = {
    Accept: 'application/json',
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const cookieHeader = getCookieHeader();
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }

  console.log(`\n${method} ${url}`);
  if (body !== undefined && args.verbose) {
    console.log(
      `request body: ${JSON.stringify(maskSensitive(body), null, 2)}`,
    );
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
  } catch (error) {
    fail(`network error calling ${method} ${path}: ${error.message}`, {
      error,
    });
  }

  storeCookies(response);
  const responseBody = await readResponseBody(response);
  const result = {
    method,
    path,
    url,
    status: response.status,
    ok: response.ok,
    body: responseBody,
    correlationId: responseBody?.correlationId,
  };

  console.log(`status: ${response.status}`);
  if (result.correlationId) {
    console.log(`correlationId: ${result.correlationId}`);
  }
  if (args.verbose || !expected.includes(response.status)) {
    console.log(`response body: ${JSON.stringify(responseBody, null, 2)}`);
  }

  if (!expected.includes(response.status)) {
    fail(
      `expected ${expected.join('/')} for ${method} ${path}, got ${response.status}`,
      result,
    );
  }

  return result;
}

function assertStep(result, label) {
  if (!result.ok) {
    fail(`${label} failed`, result);
  }
  console.log(`OK: ${label}`);
}

function fail(message, context) {
  console.error(`\nFAIL: ${message}`);
  if (context) {
    console.error(JSON.stringify(safeContext(context), null, 2));
  }
  process.exit(1);
}

function printHeader() {
  console.log('CRM onboarding smoke test');
  console.log(`baseUrl: ${baseUrl}`);
  console.log(`email: ${payload.email}`);
  console.log(`fullName: ${payload.fullName}`);
  console.log(`company: ${companyName}`);
  console.log(`complete: ${args.complete ? 'yes' : 'no'}`);
}

async function readResponseBody(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  const text = await response.text();
  return text ? { raw: text } : null;
}

function storeCookies(response) {
  const setCookieValues = getSetCookieValues(response.headers);
  for (const setCookie of setCookieValues) {
    const [pair] = setCookie.split(';');
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) continue;
    const name = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (name && value) {
      cookieJar.set(name, value);
    }
  }
}

function getSetCookieValues(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function getCookieHeader() {
  return [...cookieJar.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function maskSensitive(value) {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, val]) => [
      key,
      key.toLowerCase().includes('password') ? '<hidden>' : val,
    ]),
  );
}

function safeContext(context) {
  return {
    method: context.method,
    path: context.path,
    status: context.status,
    correlationId: context.correlationId,
    body: context.body,
    error: context.error?.message,
  };
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}

function buildBaseUrlFromEnv() {
  const backend = process.env.BACKEND_DOMAIN?.replace(/\/+$/, '');
  const prefix = process.env.API_PREFIX || 'api';
  if (!backend) return null;
  return `${backend}/${prefix}/v1`;
}

function loadDotEnv() {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, '');
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
