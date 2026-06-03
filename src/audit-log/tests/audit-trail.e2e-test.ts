/**
 * Audit Trail Integration Test Script
 *
 * Tests the full audit trail pipeline:
 *   Service → EventEmitter → AuditLogListener → BullMQ → AuditLogProcessor → MongoDB → REST API
 *
 * Prerequisites:
 *   - CRM API running (API + Worker)
 *   - MongoDB accessible
 *   - Redis accessible
 *   - Valid auth cookies or session
 *
 * Usage:
 *   # Set env vars
 *   $env:API_BASE_URL = "http://localhost:3001"
 *   $env:AUTH_COOKIE = "sid=<your-session-cookie>"
 *
 *   # Run
 *   npx ts-node src/audit-log/tests/audit-trail.e2e-test.ts
 */

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const AUTH_COOKIE = process.env.AUTH_COOKIE || '';
const WAIT_FOR_WORKER_MS = 3000; // Wait for BullMQ worker to process

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

async function apiCall(method: string, path: string, body?: any) {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Cookie: AUTH_COOKIE,
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: res.status, data };
}

function assert(name: string, condition: boolean, details: string) {
  results.push({ name, passed: condition, details });
  const icon = condition ? '✅' : '❌';
  console.log(`  ${icon} ${name}: ${details}`);
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ──────────────────────────────────────────────────────────────────
// TEST 1: Create a contact, update it, verify audit log is generated
// ──────────────────────────────────────────────────────────────────
async function testContactUpdateAudit() {
  console.log('\n📋 TEST 1: Contact Update → Audit Log Pipeline');
  console.log('───────────────────────────────────────────────');

  // Step 1: Create a test contact
  const createRes = await apiCall('POST', '/contacts', {
    firstName: 'AuditTest',
    lastName: `E2E_${Date.now()}`,
    emails: ['audit-test@example.com'],
  });
  assert(
    'Create contact',
    createRes.status === 201 || createRes.status === 200,
    `Status: ${createRes.status}, ID: ${createRes.data?.id || createRes.data?._id || 'N/A'}`,
  );
  const contactId = createRes.data?.id || createRes.data?._id;
  if (!contactId) return;

  // Step 2: Update the contact (trigger audit event)
  const updateRes = await apiCall('PATCH', `/contacts/${contactId}`, {
    firstName: 'AuditUpdated',
    title: 'QA Engineer',
    companyName: 'TestCorp',
  });
  assert(
    'Update contact',
    updateRes.status === 200,
    `Status: ${updateRes.status}, firstName: ${updateRes.data?.firstName}`,
  );

  // Step 3: Wait for BullMQ worker to process the audit job
  console.log(`  ⏳ Waiting ${WAIT_FOR_WORKER_MS}ms for worker to process...`);
  await sleep(WAIT_FOR_WORKER_MS);

  // Step 4: Query audit logs via REST API
  const auditRes = await apiCall(
    'GET',
    `/v1/audit-logs/CONTACT/${contactId}?limit=10`,
  );
  assert(
    'Fetch audit logs',
    auditRes.status === 200,
    `Status: ${auditRes.status}, entries: ${auditRes.data?.data?.length || 0}`,
  );

  const entries = auditRes.data?.data || [];
  assert(
    'Audit log created',
    entries.length > 0,
    `Found ${entries.length} audit log entries`,
  );

  if (entries.length > 0) {
    const latest = entries[0];

    // Verify fields
    assert('Has timestamp (t)', !!latest.t, `t = ${latest.t}`);
    assert('Has execution source (src)', !!latest.src, `src = ${latest.src}`);
    assert(
      'Source is Manual (M)',
      latest.src === 'M',
      `Expected 'M', got '${latest.src}'`,
    );
    assert(
      'Has actorId',
      !!latest.actorId && latest.actorId !== 'system',
      `actorId = ${latest.actorId}`,
    );
    assert(
      'Has changes array',
      Array.isArray(latest.changes) && latest.changes.length > 0,
      `changes.length = ${latest.changes?.length}`,
    );

    // Verify field-level diff
    const firstNameChange = latest.changes.find(
      (c: any) => c.f === 'firstName',
    );
    assert(
      'firstName change detected',
      !!firstNameChange,
      firstNameChange
        ? `${firstNameChange.o} → ${firstNameChange.n}`
        : 'Not found in changes',
    );
    assert(
      'firstName old value correct',
      firstNameChange?.o === 'AuditTest',
      `Expected 'AuditTest', got '${firstNameChange?.o}'`,
    );
    assert(
      'firstName new value correct',
      firstNameChange?.n === 'AuditUpdated',
      `Expected 'AuditUpdated', got '${firstNameChange?.n}'`,
    );

    const titleChange = latest.changes.find((c: any) => c.f === 'title');
    assert(
      'title change detected',
      !!titleChange,
      titleChange ? `${titleChange.o} → ${titleChange.n}` : 'Not found',
    );
  }

  // Step 5: Cleanup — delete test contact
  await apiCall('DELETE', `/contacts/${contactId}`);
  console.log(`  🧹 Cleaned up test contact ${contactId}`);
}

// ──────────────────────────────────────────────────────────────────
// TEST 2: Cursor pagination
// ──────────────────────────────────────────────────────────────────
async function testCursorPagination() {
  console.log('\n📋 TEST 2: Cursor-Based Pagination');
  console.log('───────────────────────────────────');

  // Create contact and make multiple updates
  const createRes = await apiCall('POST', '/contacts', {
    firstName: 'PaginationTest',
    lastName: `E2E_${Date.now()}`,
  });
  const contactId = createRes.data?.id || createRes.data?._id;
  if (!contactId) {
    assert('Create contact for pagination', false, 'Failed to create');
    return;
  }

  // Make 3 sequential updates
  for (let i = 1; i <= 3; i++) {
    await apiCall('PATCH', `/contacts/${contactId}`, {
      title: `Title V${i}`,
    });
    await sleep(100); // Small delay between updates
  }

  await sleep(WAIT_FOR_WORKER_MS);

  // Page 1: limit=2
  const page1 = await apiCall(
    'GET',
    `/v1/audit-logs/CONTACT/${contactId}?limit=2`,
  );
  assert(
    'Page 1 returns data',
    page1.status === 200 && (page1.data?.data?.length || 0) > 0,
    `entries: ${page1.data?.data?.length}, hasMore: ${page1.data?.hasMore}`,
  );

  if (page1.data?.nextCursor) {
    // Page 2: using cursor
    const page2 = await apiCall(
      'GET',
      `/v1/audit-logs/CONTACT/${contactId}?limit=2&cursor=${encodeURIComponent(page1.data.nextCursor)}`,
    );
    assert(
      'Page 2 returns data via cursor',
      page2.status === 200,
      `entries: ${page2.data?.data?.length}, hasMore: ${page2.data?.hasMore}`,
    );
    assert(
      'Page 2 entries are different from page 1',
      page2.data?.data?.[0]?._id !== page1.data?.data?.[0]?._id,
      'Different entry IDs confirmed',
    );
  } else {
    assert('Cursor returned for pagination', false, 'nextCursor is null');
  }

  // Cleanup
  await apiCall('DELETE', `/contacts/${contactId}`);
  console.log(`  🧹 Cleaned up test contact ${contactId}`);
}

// ──────────────────────────────────────────────────────────────────
// TEST 3: Permission gate
// ──────────────────────────────────────────────────────────────────
async function testPermissionGate() {
  console.log('\n📋 TEST 3: Permission Gate (audit_logs:view)');
  console.log('──────────────────────────────────────────────');

  // Unauthenticated request
  const noAuthRes = await fetch(
    `${API_BASE}/v1/audit-logs/CONTACT/000000000000000000000000?limit=1`,
  );
  assert(
    'Unauthenticated request blocked',
    noAuthRes.status === 401 || noAuthRes.status === 403,
    `Status: ${noAuthRes.status}`,
  );
}

// ──────────────────────────────────────────────────────────────────
// TEST 4: Truncation (long text field)
// ──────────────────────────────────────────────────────────────────
async function testLongTextTruncation() {
  console.log('\n📋 TEST 4: Long Text Truncation (> 256 chars)');
  console.log('───────────────────────────────────────────────');

  const createRes = await apiCall('POST', '/contacts', {
    firstName: 'TruncateTest',
    lastName: `E2E_${Date.now()}`,
  });
  const contactId = createRes.data?.id || createRes.data?._id;
  if (!contactId) {
    assert('Create contact for truncation test', false, 'Failed');
    return;
  }

  // Update with a very long address
  const longText = 'A'.repeat(500);
  await apiCall('PATCH', `/contacts/${contactId}`, {
    address: longText,
  });
  await sleep(WAIT_FOR_WORKER_MS);

  const auditRes = await apiCall(
    'GET',
    `/v1/audit-logs/CONTACT/${contactId}?limit=1`,
  );

  const entries = auditRes.data?.data || [];
  if (entries.length > 0) {
    const addressChange = entries[0].changes.find(
      (c: any) => c.f === 'address',
    );
    assert(
      'Long text is truncated',
      !!addressChange &&
        typeof addressChange.n === 'string' &&
        addressChange.n.startsWith('[Text Modified:'),
      addressChange
        ? `Truncated to: ${addressChange.n.slice(0, 60)}...`
        : 'address change not found',
    );
  }

  await apiCall('DELETE', `/contacts/${contactId}`);
  console.log(`  🧹 Cleaned up test contact ${contactId}`);
}

// ──────────────────────────────────────────────────────────────────
// RUNNER
// ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║   AUDIT TRAIL E2E TEST SUITE                  ║');
  console.log('║   API: ' + API_BASE.padEnd(40) + '║');
  console.log('╚════════════════════════════════════════════════╝');

  if (!AUTH_COOKIE) {
    console.log(
      '\n⚠️  WARNING: AUTH_COOKIE not set. Auth-required tests will fail.',
    );
    console.log('   Set: $env:AUTH_COOKIE = "sid=<value>"');
  }

  await testContactUpdateAudit();
  await testCursorPagination();
  await testPermissionGate();
  await testLongTextTruncation();

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.log('\n╔════════════════════════════════════════════════╗');
  console.log(
    `║   RESULTS: ${passed}/${total} passed, ${failed} failed`.padEnd(49) + '║',
  );
  console.log('╚════════════════════════════════════════════════╝');

  if (failed > 0) {
    console.log('\n❌ FAILED TESTS:');
    results
      .filter((r) => !r.passed)
      .forEach((r) => console.log(`   - ${r.name}: ${r.details}`));
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
  }
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
