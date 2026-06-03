/*
 * Verify the contact dedup query is index-backed (IXSCAN, not COLLSCAN).
 *
 * Run with mongosh against the CRM database:
 *   TENANT_ID=<24-hex tenant id> \
 *   mongosh "mongodb://localhost:27017/crm" --file src/scripts/load-test/verify-index.js
 *
 * Optionally override the sample lookup values:
 *   SAMPLE_EMAIL=user1@example.com SAMPLE_PHONE=+84910000001 mongosh ... --file ...
 */
(function () {
  const tenantId = process.env.TENANT_ID;
  if (!tenantId) {
    print('ERROR: set TENANT_ID env var (the tenant whose contacts to query)');
    quit(1);
  }
  const sampleEmail = process.env.SAMPLE_EMAIL || 'user1@example.com';
  const samplePhone = process.env.SAMPLE_PHONE || '+84910000001';

  print('\n── Indexes on `contacts` ──');
  db.contacts.getIndexes().forEach((ix) => {
    print('  ' + ix.name + '  ' + JSON.stringify(ix.key));
  });

  const required = ['tenant_phone_lookup'];
  const names = db.contacts.getIndexes().map((i) => i.name);
  const hasEmailIdx = db.contacts
    .getIndexes()
    .some((i) => i.key.tenantId === 1 && i.key.emails === 1);
  print('\n  { tenantId:1, emails:1 } present : ' + hasEmailIdx);
  required.forEach((n) =>
    print('  index "' + n + '" present       : ' + names.includes(n)),
  );

  // Dedup query shape used by ContactImportProcessor.processBatch
  const query = {
    tenantId: tenantId,
    deletedAt: { $exists: false },
    $or: [{ emails: { $in: [sampleEmail] } }, { phones: { $in: [samplePhone] } }],
  };

  print('\n── explain("executionStats") for the dedup query ──');
  const exp = db.contacts.find(query).explain('executionStats');
  const planStr = JSON.stringify(exp.queryPlanner.winningPlan);
  const stats = exp.executionStats;

  const usesIxscan = planStr.indexOf('IXSCAN') !== -1;
  const usesCollscan = planStr.indexOf('COLLSCAN') !== -1;

  print('  totalDocsExamined : ' + stats.totalDocsExamined);
  print('  totalKeysExamined : ' + stats.totalKeysExamined);
  print('  nReturned         : ' + stats.nReturned);
  print('  executionTimeMs   : ' + stats.executionTimeMillis);
  print('  uses IXSCAN       : ' + usesIxscan);
  print('  uses COLLSCAN     : ' + usesCollscan);

  const pass = usesIxscan && !usesCollscan && hasEmailIdx && names.includes('tenant_phone_lookup');
  print('\n  RESULT : ' + (pass ? 'PASS ✅ (index-backed)' : 'FAIL ❌ (collection scan!)'));
  quit(pass ? 0 : 1);
})();
