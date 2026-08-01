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
  const tenantIdRaw = process.env.TENANT_ID;
  if (!tenantIdRaw || !/^[a-fA-F0-9]{24}$/.test(tenantIdRaw)) {
    print('ERROR: set TENANT_ID to the tenant ObjectId (24 hex characters)');
    quit(1);
  }
  const tenantId = ObjectId(tenantIdRaw);
  const sampleEmail = process.env.SAMPLE_EMAIL || 'user1@example.com';
  const samplePhone = process.env.SAMPLE_PHONE || '+84910000001';

  print('\n── Indexes on `contacts` ──');
  db.contacts.getIndexes().forEach((ix) => {
    print('  ' + ix.name + '  ' + JSON.stringify(ix.key));
  });

  const required = [
    'tenant_phone_lookup',
    'tenant_active_list',
    'tenant_active_updatedAt_cursor',
    'tenant_active_firstName_cursor',
    'tenant_active_lastName_cursor',
    'tenant_active_score_cursor',
    'contact_text_search',
  ];
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
    deletedAt: null,
    $or: [
      { emails: { $in: [sampleEmail] } },
      { phones: { $in: [samplePhone] } },
    ],
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

  let pass =
    usesIxscan &&
    !usesCollscan &&
    hasEmailIdx &&
    required.every((name) => names.includes(name));

  function verifyListPlan(label, query, sort) {
    const explanation = db.contacts
      .find(query)
      .sort(sort)
      .limit(101)
      .explain('executionStats');
    const winningPlan = JSON.stringify(explanation.queryPlanner.winningPlan);
    const indexed =
      winningPlan.indexOf('IXSCAN') !== -1 &&
      winningPlan.indexOf('COLLSCAN') === -1 &&
      winningPlan.indexOf('SORT') === -1;
    print(
      '  ' +
        label.padEnd(24) +
        ': ' +
        (indexed ? 'PASS' : 'FAIL') +
        ' docs=' +
        explanation.executionStats.totalDocsExamined +
        ' keys=' +
        explanation.executionStats.totalKeysExamined +
        ' ms=' +
        explanation.executionStats.executionTimeMillis,
    );
    return indexed;
  }

  print('\nâ”€â”€ explain("executionStats") for Contact list cursor sorts â”€â”€');
  const active = { tenantId: tenantId, deletedAt: null };
  pass = verifyListPlan('createdAt desc', active, { createdAt: -1, _id: -1 }) && pass;
  ['updatedAt', 'firstName', 'lastName', 'score'].forEach((field) => {
    const sort = {};
    sort[field] = 1;
    sort._id = 1;
    pass = verifyListPlan(field + ' asc', active, sort) && pass;
  });
  print(
    '\n  RESULT : ' +
      (pass ? 'PASS ✅ (index-backed)' : 'FAIL ❌ (collection scan!)'),
  );
  quit(pass ? 0 : 1);
})();
