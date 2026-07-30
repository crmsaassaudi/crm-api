import { Schema } from 'mongoose';
import { EntityReference } from '../../../common/references/entity-reference';
import { CONTACT_REFERENCES } from '../../../contacts/contact-references.registry';
import { ACCOUNT_REFERENCES } from '../../../accounts/merge/account-references.registry';
import { DEAL_REFERENCES } from '../../../deals/deal-references.registry';
import { TICKET_REFERENCES } from '../../../tickets/ticket-references.registry';
import { TASK_REFERENCES } from '../../../tasks/task-references.registry';

import { ContactSchema } from '../../../contacts/infrastructure/persistence/document/entities/contact.schema';
import { AccountSchema } from '../../../accounts/infrastructure/persistence/document/entities/account.schema';
import { DealSchema } from '../../../deals/infrastructure/persistence/document/entities/deal.schema';
import { TicketSchema } from '../../../tickets/infrastructure/persistence/document/entities/ticket.schema';
import { TaskSchema } from '../../../tasks/infrastructure/persistence/document/entities/task.schema';
import { NoteSchema } from '../../../notes/infrastructure/persistence/document/entities/note.schema';
import { ActivityLogSchema } from '../../../activity-log/infrastructure/persistence/document/entities/activity-log.schema';
import { AuditLogSchema } from '../../../audit-log/entities/audit-log.schema';
import { OmniConversationSchema } from '../../../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';
import { EmailContentSchema } from '../../../channels/infrastructure/persistence/document/entities/email-content.schema';
import { ContactRelationSchema } from '../../../contacts/relations/contact-relation.schema';
import { AccountContactRelationSchema } from '../../../contacts/relations/account-contact-relation.schema';
import { ContactIdentitySchema } from '../../../contacts/identities/contact-identity.schema';
import { InteractionSegmentSchema } from '../../../omni-inbound/infrastructure/persistence/document/entities/interaction-segment.schema';

/**
 * Every reference registry, checked against the real schemas.
 *
 * Five domains now declare what points at them, and every entry addresses a collection by
 * raw string through the shared connection — because injecting a dozen feature modules
 * into each other creates dependency cycles. Nothing type-checks those strings, so a typo
 * makes a merge move zero rows and a purge orphan every one of them, both reporting
 * success. This inventory is the missing type check, in one place rather than five.
 */

const SCHEMAS: Record<string, Schema> = {
  contacts: ContactSchema,
  accounts: AccountSchema,
  deals: DealSchema,
  tickets: TicketSchema,
  tasks: TaskSchema,
  notes: NoteSchema,
  activity_logs: ActivityLogSchema,
  audit_logs: AuditLogSchema,
  omni_conversations: OmniConversationSchema,
  email_contents: EmailContentSchema,
  contact_relations: ContactRelationSchema,
  account_contact_relations: AccountContactRelationSchema,
  contact_identities: ContactIdentitySchema,
  interaction_segments: InteractionSegmentSchema,
};

interface Registry {
  readonly name: string;
  readonly references: readonly EntityReference[];
}

const REGISTRIES: readonly Registry[] = [
  { name: 'contact', references: CONTACT_REFERENCES as EntityReference[] },
  { name: 'account', references: ACCOUNT_REFERENCES as EntityReference[] },
  { name: 'deal', references: DEAL_REFERENCES },
  { name: 'ticket', references: TICKET_REFERENCES },
  { name: 'task', references: TASK_REFERENCES },
];

/** Field paths a schema declares, including the `a.b` leaves of a sub-document. */
function schemaPaths(schema: Schema): Set<string> {
  const paths = new Set(Object.keys(schema.paths));
  for (const path of Object.keys(schema.paths)) {
    paths.add(path.split('.')[0]);
  }
  return paths;
}

describe('reference registry inventory', () => {
  it('should cover all five domains', () => {
    expect(REGISTRIES).toHaveLength(5);
    for (const registry of REGISTRIES) {
      expect(registry.references.length).toBeGreaterThan(0);
    }
  });

  it.each(REGISTRIES)(
    'every $name reference should name a real collection and field',
    ({ references }) => {
      for (const ref of references) {
        const schema = SCHEMAS[ref.collection];
        expect(schema).toBeDefined();
        // The collection name the registry uses must be the one the schema binds.
        expect((schema as any).options.collection).toBe(ref.collection);
        // And the field must exist on that schema. `relatedTo` is a Mixed sub-document,
        // so only its root is a declared path.
        expect([...schemaPaths(schema)]).toContain(ref.field);
      }
    },
  );

  it.each(REGISTRIES)(
    'every discriminated $name reference should name its discriminator field',
    ({ references }) => {
      for (const ref of references) {
        if (ref.kind !== 'discriminatedString' && ref.kind !== 'relatedTo') {
          continue;
        }
        expect(ref.discriminator?.field).toBeTruthy();
        expect(ref.discriminator?.value).toBeTruthy();

        // `discriminatedString` scopes by a sibling column, which the schema must
        // declare. `relatedTo` scopes by a key INSIDE a Mixed sub-document, which by
        // definition has no declared path — asserting one would fail for a correct entry.
        if (ref.kind === 'discriminatedString') {
          const schema = SCHEMAS[ref.collection];
          expect([...schemaPaths(schema)]).toContain(ref.discriminator!.field);
        }
      }
    },
  );

  it.each(REGISTRIES)(
    'every $name reference should carry a policy pair and a human label',
    ({ references }) => {
      for (const ref of references) {
        expect(['reparent', 'keep']).toContain(ref.onMerge);
        expect(['cascade', 'detach', 'pull', 'keep']).toContain(ref.onPurge);
        // Users accept destructive operations against these labels, so a label is
        // required. It is NOT required to differ from the collection name — "deals" and
        // "tasks" are already the words a person would use, and asserting otherwise (as
        // the first version of this test did) demands paraphrase for its own sake.
        expect(ref.label).toBeTruthy();
      }
    },
  );

  it('should keep the audit trail out of every cascade', () => {
    // The audit trail records what happened to a specific id. Rewriting it on merge or
    // deleting it on purge would falsify the record of the operation doing the rewriting.
    for (const { name, references } of REGISTRIES) {
      const audit = references.find((r) => r.collection === 'audit_logs');
      expect({ name, found: Boolean(audit) }).toEqual({ name, found: true });
      expect({ name, onMerge: audit!.onMerge }).toEqual({
        name,
        onMerge: 'keep',
      });
      expect({ name, onPurge: audit!.onPurge }).toEqual({
        name,
        onPurge: 'keep',
      });
    }
  });

  it('should never cascade-delete a record with independent value', () => {
    // The invariant that matters most across all five: purging a parent must not destroy
    // revenue, support history, people, or somebody's work item.
    const INDEPENDENT = new Set(['deals', 'tickets', 'contacts', 'tasks']);
    const offenders: string[] = [];

    for (const { name, references } of REGISTRIES) {
      for (const ref of references) {
        if (INDEPENDENT.has(ref.collection) && ref.onPurge === 'cascade') {
          offenders.push(`${name} → ${ref.collection}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('should not let two registries disagree about the same collection and field', () => {
    // `tasks.relatedTo` appears in three registries with three different discriminator
    // values, which is correct. What would NOT be correct is two registries giving the
    // same (collection, field, discriminator) different purge policies — that is one
    // fact with two answers, and whichever purge ran last would win.
    const seen = new Map<string, string>();
    const conflicts: string[] = [];

    for (const { name, references } of REGISTRIES) {
      for (const ref of references) {
        const key = `${ref.collection}.${ref.field}#${
          ref.discriminator?.value ?? ''
        }`;
        const previous = seen.get(key);
        if (previous && previous !== ref.onPurge) {
          conflicts.push(`${key}: ${previous} vs ${ref.onPurge} (${name})`);
        }
        seen.set(key, ref.onPurge);
      }
    }

    expect(conflicts).toEqual([]);
  });
});
