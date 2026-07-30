import { Types } from 'mongoose';
import {
  CONTACT_REFERENCES,
  MERGE_REFERENCES,
  buildReferenceFilter,
  buildReparentUpdate,
} from './contact-references.registry';

import { NoteSchema } from '../notes/infrastructure/persistence/document/entities/note.schema';
import { TicketSchema } from '../tickets/infrastructure/persistence/document/entities/ticket.schema';
import { DealSchema } from '../deals/infrastructure/persistence/document/entities/deal.schema';
import { TaskSchema } from '../tasks/infrastructure/persistence/document/entities/task.schema';
import { OmniConversationSchema } from '../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';
import { EmailContentSchema } from '../channels/infrastructure/persistence/document/entities/email-content.schema';
import { ActivityLogSchema } from '../activity-log/infrastructure/persistence/document/entities/activity-log.schema';
import { AuditLogSchema } from '../audit-log/entities/audit-log.schema';
import { ContactRelationSchema } from './relations/contact-relation.schema';
import { AccountContactRelationSchema } from './relations/account-contact-relation.schema';
import { ContactIdentitySchema } from './identities/contact-identity.schema';

const CONTACT_ID = '60d0fe4f5311236168a109ca';
const SURVIVOR_ID = '60d0fe4f5311236168a109cb';
const TENANT_ID = '60d0fe4f5311236168a109cc';

/**
 * The registry addresses collections by raw name through the shared Mongoose
 * connection (importing eight feature modules into ContactsModule would create
 * dependency cycles), so nothing type-checks these strings. A typo would make
 * merge silently move zero rows and purge silently orphan them — the exact
 * failure mode the registry was built to eliminate, reintroduced one level down.
 *
 * These tests are that missing type check: each entry is pinned against the real
 * schema's collection name and field path.
 */
const SCHEMAS = {
  notes: NoteSchema,
  tickets: TicketSchema,
  deals: DealSchema,
  tasks: TaskSchema,
  omni_conversations: OmniConversationSchema,
  email_contents: EmailContentSchema,
  contact_relations: ContactRelationSchema,
  account_contact_relations: AccountContactRelationSchema,
  contact_identities: ContactIdentitySchema,
  activity_logs: ActivityLogSchema,
  audit_logs: AuditLogSchema,
} as const;

describe('CONTACT_REFERENCES matches the real schemas', () => {
  it('should cover every collection with a registered schema', () => {
    // Deduped: `contact_relations` legitimately appears twice, once per endpoint
    // field, because a merge must move rows where the contact is the subject AND
    // rows where it is the related party.
    const registered = Array.from(
      new Set(CONTACT_REFERENCES.map((r) => r.collection)),
    ).sort();
    expect(registered).toEqual(Object.keys(SCHEMAS).sort());
  });

  it.each(CONTACT_REFERENCES)(
    'should name a real collection and field for $collection.$field',
    (ref) => {
      const schema = (SCHEMAS as Record<string, any>)[ref.collection];
      expect(schema).toBeDefined();
      // The collection name the registry uses must be the one the schema binds.
      expect(schema.options.collection).toBe(ref.collection);
      // And the field must exist on that schema.
      expect(Object.keys(schema.paths)).toContain(ref.field);
    },
  );

  it('should give every entry a merge and a purge policy', () => {
    for (const ref of CONTACT_REFERENCES) {
      expect(['reparent', 'keep']).toContain(ref.onMerge);
      expect(['cascade', 'detach', 'pull', 'keep']).toContain(ref.onPurge);
      expect(ref.label).toBeTruthy();
    }
  });

  it('should register BOTH endpoints of the person relationship graph', () => {
    // Registering only `fromContactId` would leave every relationship pointing AT
    // the merged-away contact dangling — the same half-migration the registry
    // exists to prevent, one level down.
    const fields = CONTACT_REFERENCES.filter(
      (r) => r.collection === 'contact_relations',
    ).map((r) => r.field);
    expect(fields.sort()).toEqual(['fromContactId', 'toContactId']);
  });

  it('should mark paired rows so merge can clear self-references and duplicates', () => {
    // Without `pairedWith`, re-parenting one endpoint onto the survivor can create
    // "B reports_to B", or collide with an existing row and abort the whole
    // updateMany on the partial unique index.
    for (const ref of CONTACT_REFERENCES.filter((r) =>
      [
        'contact_relations',
        'account_contact_relations',
        'contact_identities',
      ].includes(r.collection),
    )) {
      expect(ref.pairedWith).toBeDefined();
      expect(ref.pairedWith!.otherField).toBeTruthy();
      expect(ref.pairedWith!.otherField).not.toBe(ref.field);
    }
  });

  it('should cascade relationship rows on purge — a relation needs both people', () => {
    for (const ref of CONTACT_REFERENCES.filter((r) =>
      [
        'contact_relations',
        'account_contact_relations',
        'contact_identities',
      ].includes(r.collection),
    )) {
      expect(ref.onPurge).toBe('cascade');
    }
  });

  it('should keep the audit trail attributable to the original record', () => {
    // Rewriting audit rows onto the survivor would falsify history: the trail
    // records what happened to a specific id. The merge itself is audited.
    const audit = CONTACT_REFERENCES.find(
      (r) => r.collection === 'audit_logs',
    )!;
    expect(audit.onMerge).toBe('keep');
    expect(audit.onPurge).toBe('keep');
  });

  it('should exclude only the audit trail from merge re-parenting', () => {
    expect(MERGE_REFERENCES.map((r) => r.collection)).not.toContain(
      'audit_logs',
    );
    // Everything except the audit trail is re-parented.
    expect(MERGE_REFERENCES).toHaveLength(CONTACT_REFERENCES.length - 1);
  });

  it('should never cascade-delete a record with independent value', () => {
    // Revenue and support history must survive the purge of a person.
    const byCollection = Object.fromEntries(
      CONTACT_REFERENCES.map((r) => [r.collection, r]),
    );
    expect(byCollection.deals.onPurge).toBe('pull');
    expect(byCollection.tickets.onPurge).toBe('detach');
    expect(byCollection.email_contents.onPurge).toBe('pull');
  });
});

describe('buildReferenceFilter', () => {
  it('should cast an ObjectId reference', () => {
    const ref = CONTACT_REFERENCES.find((r) => r.collection === 'notes')!;
    const filter = buildReferenceFilter(ref, CONTACT_ID, TENANT_ID);
    expect(filter.contactId).toBeInstanceOf(Types.ObjectId);
    expect(String(filter.contactId)).toBe(CONTACT_ID);
    // Always tenant-scoped: these run on the raw connection, which has no
    // tenantFilterPlugin to add it.
    expect(filter.tenantId).toBeInstanceOf(Types.ObjectId);
  });

  it('should scope a discriminated string reference by its type field', () => {
    const ref = CONTACT_REFERENCES.find(
      (r) => r.collection === 'activity_logs',
    )!;
    const filter = buildReferenceFilter(ref, CONTACT_ID, TENANT_ID);
    // activity_logs holds rows for every entity type — without the
    // discriminator a merge would re-parent deals' and tickets' rows too.
    expect(filter.targetType).toBe('contact');
    expect(filter.targetId).toBe(CONTACT_ID);
  });

  it('should match both relatedTo._id and the legacy relatedTo.id', () => {
    const ref = CONTACT_REFERENCES.find((r) => r.collection === 'tasks')!;
    const filter = buildReferenceFilter(ref, CONTACT_ID, TENANT_ID);
    expect(filter['relatedTo.type']).toBe('Contact');
    // TaskRepository queries both shapes, so re-parenting has to as well or it
    // silently misses every task written before the rename.
    expect(filter.$or).toEqual([
      { 'relatedTo._id': CONTACT_ID },
      { 'relatedTo.id': CONTACT_ID },
    ]);
  });
});

describe('buildReparentUpdate', () => {
  it('should set an ObjectId reference to the survivor', () => {
    const ref = CONTACT_REFERENCES.find((r) => r.collection === 'tickets')!;
    const update = buildReparentUpdate(ref, SURVIVOR_ID);
    expect(String(update.$set.contactId)).toBe(SURVIVOR_ID);
  });

  it('should ADD to an array rather than replacing it', () => {
    // A deal can reference several contacts; `$set` of the whole array would
    // drop everyone else on it.
    const ref = CONTACT_REFERENCES.find((r) => r.collection === 'deals')!;
    const update = buildReparentUpdate(ref, SURVIVOR_ID);
    expect(update.$addToSet).toBeDefined();
    expect(update.$set).toBeUndefined();
  });

  it('should write relatedTo._id as a string, matching how tasks store it', () => {
    const ref = CONTACT_REFERENCES.find((r) => r.collection === 'tasks')!;
    const update = buildReparentUpdate(ref, SURVIVOR_ID);
    expect(update.$set['relatedTo._id']).toBe(SURVIVOR_ID);
    expect(typeof update.$set['relatedTo._id']).toBe('string');
  });
});
