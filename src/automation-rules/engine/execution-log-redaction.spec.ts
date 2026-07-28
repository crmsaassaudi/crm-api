import {
  REDACTED,
  slimActionConfigForLog,
  slimOutputForLog,
  slimRecordForLog,
} from './execution-log-redaction';

/**
 * `automation_execution_logs` used to persist the complete CRM record in
 * `step.input.recordData` for 30 days, readable with `automation_logs:view`.
 */
describe('slimRecordForLog', () => {
  const record = {
    _id: 'c1',
    ownerId: 'u1',
    statusId: 's1',
    priority: 'HIGH',
    firstName: 'Ada',
    lastName: 'Lovelace',
    emails: ['ada@example.com'],
    phones: ['+84900000000'],
    notes: 'Prefers to be called in the morning',
    customFields: { nationalId: '0123456789' },
  };

  it('should keep identity and routing fields', () => {
    const slim = slimRecordForLog(record)!;

    expect(slim._id).toBe('c1');
    expect(slim.ownerId).toBe('u1');
    expect(slim.statusId).toBe('s1');
    expect(slim.priority).toBe('HIGH');
  });

  it('should drop every contact and free-text field', () => {
    const slim = slimRecordForLog(record)!;

    for (const leaked of [
      'firstName',
      'lastName',
      'emails',
      'phones',
      'notes',
      'customFields',
    ]) {
      expect(slim).not.toHaveProperty(leaked);
    }
  });

  it('should report how many fields it dropped', () => {
    const slim = slimRecordForLog(record)!;

    // 6 dropped of 10; a reader can tell "not stored" from "record was empty".
    expect(slim._fieldsOmitted).toBe(6);
  });

  it('should return undefined for a non-object', () => {
    expect(slimRecordForLog(null)).toBeUndefined();
    expect(slimRecordForLog('nope')).toBeUndefined();
    expect(slimRecordForLog([1, 2])).toBeUndefined();
  });
});

describe('slimActionConfigForLog', () => {
  it('should redact credentials and message bodies', () => {
    const slim = slimActionConfigForLog({
      actionType: 'webhook',
      webhookUrl: 'https://hooks.example.com/x',
      headers: { Authorization: 'Bearer super-secret' },
      apiKey: 'sk_live_123',
      bodyTemplate: '{{firstName}} {{emails.0}}',
    })!;

    // Kept: what the log is for.
    expect(slim.actionType).toBe('webhook');
    expect(slim.webhookUrl).toBe('https://hooks.example.com/x');
    // Redacted: credentials and interpolated PII.
    expect(slim.headers).toBe(REDACTED);
    expect(slim.apiKey).toBe(REDACTED);
    expect(slim.bodyTemplate).toBe(REDACTED);
  });

  it('should truncate a long string rather than dropping it', () => {
    const slim = slimActionConfigForLog({ subject: 'x'.repeat(500) })!;

    expect(String(slim.subject)).toHaveLength(200 + '… [truncated]'.length);
    expect(String(slim.subject)).toMatch(/\[truncated\]$/);
  });
});

describe('slimOutputForLog', () => {
  it('should redact the recipient an executor echoes back', () => {
    const slim = slimOutputForLog({
      to: 'ada@example.com',
      status: 200,
      dryRun: false,
    })!;

    expect(slim.to).toBe(REDACTED);
    // Non-identifying fields survive — the log still says what happened.
    expect(slim.status).toBe(200);
    expect(slim.dryRun).toBe(false);
  });

  it('should keep the shape of a recipient list without the ids', () => {
    const slim = slimOutputForLog({ recipientIds: ['u1', 'u2', 'u3'] })!;

    expect(slim.recipientIds).toBe('3 value(s)');
  });
});
