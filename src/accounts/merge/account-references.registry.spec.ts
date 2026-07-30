import { Types } from 'mongoose';
import {
  ACCOUNT_REFERENCES,
  ACCOUNT_MERGE_REFERENCES,
  buildAccountReferenceFilter,
  buildAccountReparentUpdate,
} from './account-references.registry';

import { ContactSchema } from '../../contacts/infrastructure/persistence/document/entities/contact.schema';
import { AccountContactRelationSchema } from '../../contacts/relations/account-contact-relation.schema';
import { DealSchema } from '../../deals/infrastructure/persistence/document/entities/deal.schema';
import { TicketSchema } from '../../tickets/infrastructure/persistence/document/entities/ticket.schema';
import { ActivityLogSchema } from '../../activity-log/infrastructure/persistence/document/entities/activity-log.schema';
import { AuditLogSchema } from '../../audit-log/entities/audit-log.schema';

const ACCOUNT_ID = '60d0fe4f5311236168a109ca';
const SURVIVOR_ID = '60d0fe4f5311236168a109cb';
const TENANT_ID = '60d0fe4f5311236168a109cc';

/**
 * The registry addresses collections by raw name through the shared connection, so
 * nothing type-checks these strings. A typo makes a merge move zero rows and report
 * success — the failure the registry exists to eliminate, reintroduced one level down.
 * These tests are the missing type check.
 */
const SCHEMAS = {
  contacts: ContactSchema,
  account_contact_relations: AccountContactRelationSchema,
  deals: DealSchema,
  tickets: TicketSchema,
  activity_logs: ActivityLogSchema,
  audit_logs: AuditLogSchema,
} as const;

describe('ACCOUNT_REFERENCES matches the real schemas', () => {
  it('should cover every collection with a registered schema', () => {
    const registered = Array.from(
      new Set(ACCOUNT_REFERENCES.map((r) => r.collection)),
    ).sort();
    expect(registered).toEqual(Object.keys(SCHEMAS).sort());
  });

  it.each(ACCOUNT_REFERENCES)(
    'should name a real collection and field for $collection.$field',
    (ref) => {
      const schema = (SCHEMAS as Record<string, any>)[ref.collection];
      expect(schema).toBeDefined();
      expect(schema.options.collection).toBe(ref.collection);
      expect(Object.keys(schema.paths)).toContain(ref.field);
    },
  );

  it('should give every entry a merge and a purge policy and a label', () => {
    for (const ref of ACCOUNT_REFERENCES) {
      expect(['reparent', 'keep']).toContain(ref.onMerge);
      expect(['cascade', 'detach', 'keep']).toContain(ref.onPurge);
      expect(ref.label).toBeTruthy();
    }
  });

  it('should register the discriminator for every discriminated reference', () => {
    // activity_logs and audit_logs hold rows for every entity type in the CRM.
    // Without the discriminator, an account merge would re-parent the timeline of
    // every deal and ticket that happened to share the id space.
    for (const ref of ACCOUNT_REFERENCES.filter(
      (r) => r.kind === 'discriminatedString',
    )) {
      expect(ref.discriminator?.field).toBeTruthy();
      expect(ref.discriminator?.value).toBeTruthy();
      const schema = (SCHEMAS as Record<string, any>)[ref.collection];
      expect(Object.keys(schema.paths)).toContain(ref.discriminator!.field);
    }
  });

  it('should mark the affiliation row as paired so merge can clear duplicates', () => {
    // If both accounts employ the same contact, re-parenting the loser's row
    // collides with the survivor's and aborts the whole updateMany.
    const ref = ACCOUNT_REFERENCES.find(
      (r) => r.collection === 'account_contact_relations',
    )!;
    expect(ref.pairedWith?.otherField).toBe('contactId');
    expect(ref.pairedWith!.otherField).not.toBe(ref.field);
  });

  it('should keep the audit trail attributable to the original account', () => {
    const audit = ACCOUNT_REFERENCES.find(
      (r) => r.collection === 'audit_logs',
    )!;
    expect(audit.onMerge).toBe('keep');
    expect(audit.onPurge).toBe('keep');
  });

  it('should exclude only the audit trail from merge re-parenting', () => {
    expect(ACCOUNT_MERGE_REFERENCES.map((r) => r.collection)).not.toContain(
      'audit_logs',
    );
    expect(ACCOUNT_MERGE_REFERENCES).toHaveLength(
      ACCOUNT_REFERENCES.length - 1,
    );
  });

  it('should never cascade-delete a record with independent value', () => {
    // Deleting a company must not delete its revenue, its support history, or the
    // people who work there. Only the affiliation row — which has no meaning
    // without the company end of it — and the account's own timeline cascade.
    const byCollection = Object.fromEntries(
      ACCOUNT_REFERENCES.map((r) => [r.collection, r]),
    );
    expect(byCollection.deals.onPurge).toBe('detach');
    expect(byCollection.tickets.onPurge).toBe('detach');
    expect(byCollection.contacts.onPurge).toBe('detach');
    expect(byCollection.account_contact_relations.onPurge).toBe('cascade');
  });
});

describe('buildAccountReferenceFilter', () => {
  it('should cast an ObjectId reference and always scope by tenant', () => {
    const ref = ACCOUNT_REFERENCES.find((r) => r.collection === 'deals')!;
    const filter = buildAccountReferenceFilter(ref, ACCOUNT_ID, TENANT_ID);
    expect(filter.accountId).toBeInstanceOf(Types.ObjectId);
    expect(String(filter.accountId)).toBe(ACCOUNT_ID);
    // These run on the raw connection, which has no tenantFilterPlugin.
    expect(filter.tenantId).toBeInstanceOf(Types.ObjectId);
  });

  it('should scope a discriminated reference by its type field', () => {
    const ref = ACCOUNT_REFERENCES.find(
      (r) => r.collection === 'activity_logs',
    )!;
    const filter = buildAccountReferenceFilter(ref, ACCOUNT_ID, TENANT_ID);
    expect(filter.targetType).toBe('account');
    // Stored as a string on activity_logs, so it must NOT be cast.
    expect(filter.targetId).toBe(ACCOUNT_ID);
  });

  it('should pass a non-ObjectId tenant id through rather than throwing', () => {
    const ref = ACCOUNT_REFERENCES.find((r) => r.collection === 'deals')!;
    const filter = buildAccountReferenceFilter(ref, ACCOUNT_ID, 'tenant_1');
    expect(filter.tenantId).toBe('tenant_1');
  });
});

describe('buildAccountReparentUpdate', () => {
  it('should set an ObjectId reference to the survivor', () => {
    const ref = ACCOUNT_REFERENCES.find((r) => r.collection === 'tickets')!;
    const update = buildAccountReparentUpdate(ref, SURVIVOR_ID);
    expect(update.$set.accountId).toBeInstanceOf(Types.ObjectId);
    expect(String(update.$set.accountId)).toBe(SURVIVOR_ID);
  });

  it('should write a discriminated reference as a string', () => {
    // activity_logs.targetId is a String path; writing an ObjectId there makes the
    // row invisible to every subsequent string-equality lookup.
    const ref = ACCOUNT_REFERENCES.find(
      (r) => r.collection === 'activity_logs',
    )!;
    const update = buildAccountReparentUpdate(ref, SURVIVOR_ID);
    expect(update.$set.targetId).toBe(SURVIVOR_ID);
    expect(typeof update.$set.targetId).toBe('string');
  });
});
