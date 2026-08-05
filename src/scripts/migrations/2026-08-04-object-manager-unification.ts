/**
 * Repairs the two ways Object Manager's configuration had come apart from the data
 * it was meant to govern.
 *
 * Part 1: the picklist split-brain
 *
 * Object Manager's Status & Sources tab wrote `crm_settings` blobs
 * (`{object}_lifecycle`, `{object}_source`) while each module's runtime validated
 * `statusId`/`sourceId`/`typeId` against a dedicated collection — `ticket_statuses`,
 * `task_statuses`, `account_statuses`, `deal_stages`. Nothing ever seeded those
 * collections, and the blob mints non-ObjectId ids (`'new'`, or a ULID for
 * admin-created rows), so:
 *
 *   - Ticket and Task rejected the id with 400 (`@IsMongoId`), which means picking
 *     a status in the form could not work at all.
 *   - Account and Deal accepted it unvalidated, producing records pointing at a
 *     stage no screen reading the collection could resolve.
 *
 * This copies every blob entry into the collection the runtime enforces, keeping a
 * `legacyId` on each document so the mapping is auditable, then rewrites records
 * that still reference a blob id.
 *
 * Contact is deliberately untouched: `contact_lifecycle` has always been its
 * authority, `CrmSettingsService` guards renames against live references, and
 * moving it would be a migration with no correctness gain.
 *
 * Part 2: layout and validation keys
 *
 * `layout_settings` and `validation_rules` stored the browser catalog's key names —
 * `owner`, `amount`, `type`, `employees`, `subject`. The server reads payload keys,
 * so a masking rule on `amount` matched no property and a required flag on `type`
 * made `data['type']` permanently absent: every ticket create returned 422 with no
 * way to clear it. The registry resolves legacy names on read, so this rewrite is
 * housekeeping rather than a prerequisite — but leaving both spellings in the data
 * means the next reader has to know about the aliases too.
 *
 * Idempotent and additive. Safe to re-run; safe to run before the deploy that
 * repoints the UI, because the API accepts both spellings throughout.
 *
 * Run:
 *   npm run migrate:object-manager-unification
 *   npm run migrate:object-manager-unification -- --dry-run
 */
import 'dotenv/config';
import mongoose, { mongo } from 'mongoose';

// Mongoose bundles its own `mongodb` copy; using its types keeps the handle from
// `mongoose.connection.db` assignable without a cast.
type Db = mongo.Db;
type ObjectId = mongo.ObjectId;
const { ObjectId } = mongo;

/** One blob → collection mapping. */
interface PicklistMigration {
  object: string;
  /** `crm_settings.key` holding the blob. */
  settingKey: string;
  /** Where inside the blob the entries live. */
  extract: (value: any) => LegacyEntry[];
  /** Target collection. */
  collection: string;
  /** Record collections and the field pointing at these ids. */
  references: Array<{ collection: string; field: string }>;
}

interface LegacyEntry {
  legacyId: string;
  label: string;
  apiName?: string;
  color?: string;
  sortOrder?: number;
  isDefault?: boolean;
  isTerminal?: boolean;
  isWon?: boolean;
  probability?: number;
}

const flattenLifecycleStatuses = (value: any): LegacyEntry[] =>
  toArray(value?.stages).flatMap((stage: any) =>
    toArray(stage?.statuses).map((status: any) => ({
      legacyId: String(status?.id ?? ''),
      label: String(status?.label ?? status?.name ?? ''),
      apiName: status?.apiName,
      color: status?.color,
      sortOrder: status?.sortOrder,
      isDefault: status?.isDefault,
      isTerminal: status?.isTerminal,
      isWon: status?.isWon,
      probability: status?.probability,
    })),
  );

const extractSources = (value: any): LegacyEntry[] =>
  toArray(value?.sources).map((entry: any) => ({
    legacyId: String(entry?.id ?? ''),
    label: String(entry?.name ?? entry?.label ?? ''),
    apiName: entry?.apiName,
  }));

const extractPipelineStages = (value: any): LegacyEntry[] =>
  toArray(value?.stages).map((stage: any) => ({
    legacyId: String(stage?.id ?? ''),
    label: String(stage?.name ?? stage?.label ?? ''),
    apiName: stage?.apiName,
    color: stage?.color,
    sortOrder: stage?.sortOrder,
    isDefault: stage?.isDefault,
    isTerminal: stage?.isTerminal,
    isWon: stage?.isWon,
    probability: stage?.probability,
  }));

export const PICKLIST_MIGRATIONS: PicklistMigration[] = [
  {
    object: 'Ticket',
    settingKey: 'ticket_lifecycle',
    extract: flattenLifecycleStatuses,
    collection: 'ticket_statuses',
    references: [{ collection: 'tickets', field: 'statusId' }],
  },
  {
    object: 'Ticket',
    settingKey: 'ticket_source',
    extract: extractSources,
    collection: 'ticket_sources',
    references: [{ collection: 'tickets', field: 'sourceId' }],
  },
  {
    object: 'Task',
    settingKey: 'task_lifecycle',
    extract: flattenLifecycleStatuses,
    collection: 'task_statuses',
    references: [{ collection: 'tasks', field: 'statusId' }],
  },
  {
    object: 'Task',
    settingKey: 'task_source',
    extract: extractSources,
    collection: 'task_sources',
    references: [{ collection: 'tasks', field: 'sourceId' }],
  },
  {
    object: 'Account',
    settingKey: 'account_lifecycle',
    extract: flattenLifecycleStatuses,
    collection: 'account_statuses',
    references: [{ collection: 'accounts', field: 'statusId' }],
  },
  {
    object: 'Account',
    settingKey: 'account_source',
    extract: extractSources,
    // Accounts have no `account_sources` collection; the blob's source list is
    // the only store, and nothing validates `sourceId`. Left alone rather than
    // inventing a collection no code reads.
    collection: '',
    references: [],
  },
  {
    object: 'Deal',
    settingKey: 'deal_pipeline',
    extract: extractPipelineStages,
    collection: 'deal_stages',
    references: [{ collection: 'deals', field: 'stageId' }],
  },
  {
    object: 'Deal',
    settingKey: 'deal_source',
    extract: extractSources,
    collection: 'deal_sources',
    references: [{ collection: 'deals', field: 'sourceId' }],
  },
];

/**
 * Legacy field names in `layout_settings` / `validation_rules`, per object.
 *
 * Mirrors `legacyAliases` and `column` in `object-registry.ts`. Duplicated
 * deliberately: a migration must describe the data as it was when it ran, and
 * importing the live registry would make a future registry edit silently change
 * what this script did.
 */
export const LEGACY_FIELD_KEYS: Record<string, Record<string, string>> = {
  Contact: {
    owner: 'ownerId',
    account: 'accountId',
    lifecycleStage: 'lifecycleStageId',
    status: 'statusId',
    source: 'sourceId',
    fullName: 'name',
  },
  Account: {
    owner: 'ownerId',
    status: 'statusId',
    employees: 'numberOfEmployees',
    accountType: 'typeId',
  },
  Deal: {
    owner: 'ownerId',
    account: 'accountId',
    stage: 'stageId',
    source: 'sourceId',
    amount: 'value',
    contact: 'contactIds',
    name: 'title',
  },
  Ticket: {
    owner: 'ownerId',
    group: 'groupId',
    contact: 'contactId',
    account: 'accountId',
    status: 'statusId',
    type: 'typeId',
    source: 'sourceId',
    category: 'categoryPath',
    subCategory: 'categoryPath',
    resolutionCode: 'resolutionCodeId',
  },
  Task: {
    owner: 'ownerId',
    assignee: 'ownerId',
    status: 'statusId',
    source: 'sourceId',
    category: 'categoryId',
    subject: 'title',
  },
};

export interface MigrationReport {
  tenants: number;
  picklistDocumentsCreated: number;
  recordsRepointed: number;
  layoutKeysRewritten: number;
  validationRuleKeysRewritten: number;
  skipped: string[];
}

export async function migrateObjectManager(
  db: Db,
  options: { dryRun?: boolean } = {},
): Promise<MigrationReport> {
  const report: MigrationReport = {
    tenants: 0,
    picklistDocumentsCreated: 0,
    recordsRepointed: 0,
    layoutKeysRewritten: 0,
    validationRuleKeysRewritten: 0,
    skipped: [],
  };

  const tenantIds = await db.collection('tenants').distinct('_id');
  report.tenants = tenantIds.length;

  for (const tenantId of tenantIds) {
    for (const migration of PICKLIST_MIGRATIONS) {
      await migratePicklist(db, tenantId, migration, options, report);
    }
    await rewriteSettingKeys(db, tenantId, options, report);
  }

  return report;
}

async function migratePicklist(
  db: Db,
  tenantId: ObjectId,
  migration: PicklistMigration,
  options: { dryRun?: boolean },
  report: MigrationReport,
): Promise<void> {
  if (!migration.collection) {
    report.skipped.push(
      `${migration.object}/${migration.settingKey}: no target collection`,
    );
    return;
  }

  const setting = await db
    .collection('crm_settings')
    .findOne({ tenantId, key: migration.settingKey });
  if (!setting) return;

  const entries = migration
    .extract(setting.value)
    .filter((entry) => entry.legacyId && entry.label);
  if (entries.length === 0) return;

  const target = db.collection(migration.collection);

  for (const entry of entries) {
    // A legacy id that is already an ObjectId means the row was created through
    // the collection API, not the blob. Nothing to copy.
    if (ObjectId.isValid(entry.legacyId) && entry.legacyId.length === 24) {
      continue;
    }

    // Idempotency key. `legacyId` is what makes a re-run a no-op and what lets an
    // operator trace a document back to the blob row it came from — an audit trail
    // matters more here than a tidy schema, because this migration rewrites
    // records to point at these ids.
    const existing = await target.findOne({
      tenantId,
      legacyId: entry.legacyId,
    });

    const newId = existing?._id ?? new ObjectId();

    if (!existing && !options.dryRun) {
      await target.insertOne({
        _id: newId,
        tenantId,
        legacyId: entry.legacyId,
        // Both spellings written: these collections disagree about `name` vs
        // `label`, and the reading code accepts either.
        name: entry.label,
        label: entry.label,
        apiName: entry.apiName ?? slug(entry.label),
        color: entry.color ?? '#64748b',
        sortOrder: entry.sortOrder ?? 0,
        isDefault: entry.isDefault ?? false,
        isTerminal: entry.isTerminal ?? false,
        ...(entry.isWon !== undefined ? { isWon: entry.isWon } : {}),
        ...(entry.probability !== undefined
          ? { probability: entry.probability }
          : {}),
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    if (!existing) report.picklistDocumentsCreated += 1;

    for (const reference of migration.references) {
      const filter = { tenantId, [reference.field]: entry.legacyId };
      if (options.dryRun) {
        report.recordsRepointed += await db
          .collection(reference.collection)
          .countDocuments(filter);
        continue;
      }
      const result = await db
        .collection(reference.collection)
        .updateMany(filter, { $set: { [reference.field]: newId } });
      report.recordsRepointed += result.modifiedCount;
    }
  }
}

async function rewriteSettingKeys(
  db: Db,
  tenantId: ObjectId,
  options: { dryRun?: boolean },
  report: MigrationReport,
): Promise<void> {
  const settings = db.collection('crm_settings');

  const layout = await settings.findOne({ tenantId, key: 'layout_settings' });
  if (layout?.value?.groupLayouts) {
    let rewritten = 0;
    const groupLayouts = layout.value.groupLayouts as Record<string, any>;

    for (const perObject of Object.values(groupLayouts)) {
      if (!perObject || typeof perObject !== 'object') continue;
      for (const [object, configs] of Object.entries(perObject)) {
        const aliases = LEGACY_FIELD_KEYS[object];
        if (!aliases || !Array.isArray(configs)) continue;
        for (const config of configs) {
          const replacement = aliases[config?.key];
          if (!replacement || replacement === config.key) continue;
          // Skip when the payload key is already present: two entries collapsing
          // onto one field would make the merge order decide the policy, and the
          // explicit entry is the one to keep.
          if (configs.some((other: any) => other?.key === replacement))
            continue;
          config.key = replacement;
          rewritten += 1;
        }
      }
    }

    if (rewritten > 0 && !options.dryRun) {
      await settings.updateOne(
        { _id: layout._id },
        { $set: { value: layout.value, updatedAt: new Date() } },
      );
    }
    report.layoutKeysRewritten += rewritten;
  }

  const validation = await settings.findOne({
    tenantId,
    key: 'validation_rules',
  });
  if (validation?.value?.rules) {
    let rewritten = 0;
    for (const [object, rules] of Object.entries(
      validation.value.rules as Record<string, any>,
    )) {
      const aliases = LEGACY_FIELD_KEYS[object];
      if (!aliases || !Array.isArray(rules)) continue;
      for (const rule of rules) {
        const replacement = aliases[rule?.field];
        if (!replacement || replacement === rule.field) continue;
        rule.field = replacement;
        rewritten += 1;
      }
    }
    if (rewritten > 0 && !options.dryRun) {
      await settings.updateOne(
        { _id: validation._id },
        { $set: { value: validation.value, updatedAt: new Date() } },
      );
    }
    report.validationRuleKeysRewritten += rewritten;
  }
}

const toArray = (value: unknown): any[] => (Array.isArray(value) ? value : []);

const slug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/(?:^_+)|(?:_+$)/g, '');

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error('DATABASE_URL is not set');

  await mongoose.connect(uri, { dbName: process.env.DATABASE_NAME });
  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error('No database handle after connect');

    console.log(
      dryRun
        ? '[object-manager] DRY RUN — counting changes, writing nothing'
        : '[object-manager] migrating',
    );

    const report = await migrateObjectManager(db, { dryRun });

    console.log(`  tenants scanned:            ${report.tenants}`);
    console.log(
      `  picklist documents created: ${report.picklistDocumentsCreated}`,
    );
    console.log(`  records repointed:          ${report.recordsRepointed}`);
    console.log(`  layout keys rewritten:      ${report.layoutKeysRewritten}`);
    console.log(
      `  validation keys rewritten:  ${report.validationRuleKeysRewritten}`,
    );
    for (const skip of [...new Set(report.skipped)]) {
      console.log(`  skipped: ${skip}`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[object-manager] migration failed:', error);
    process.exit(1);
  });
}
