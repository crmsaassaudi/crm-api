import 'dotenv/config';
import { MongoClient, ObjectId, type Db, type Document } from 'mongodb';

/**
 * Migrates the two legacy assignment engines onto the consolidated model.
 *
 * What moves:
 *   1. `routing_rules`            → `assignment_rules` { objectType: 'Conversation' }
 *   2. `assignment_rules` (old)   → same collection, reshaped
 *                                   (module → objectType, actions → canonical)
 *   3. `crm_settings.omni_routing` → `assignment_settings` { objectType: 'Conversation' }
 *   4. `assignment_settings` (old) → same collection, reshaped
 *   5. `omni_presence.requireOnlineForAssignment[module]`
 *                                  → `assignment_settings.requireOnline`
 *   6. `omni_assignment_audit_logs` → `assignment_audit_logs`
 *   7. `users.skills` free text     → skill apiNames, creating catalogue entries
 *
 * Idempotent throughout: every step recognises already-migrated documents and
 * skips them, so it is safe to re-run after a partial failure.
 *
 * Run with `--dry-run` to report what would change without writing.
 * Run with `--drop-legacy` to remove `routing_rules` and
 * `omni_assignment_audit_logs` once the results have been verified. Without it
 * they are left in place, read-only, as a rollback path.
 *
 *   npm run migrate:assignment-consolidation -- --dry-run
 *   npm run migrate:assignment-consolidation
 *   npm run migrate:assignment-consolidation -- --drop-legacy
 */

const DRY_RUN = process.argv.includes('--dry-run');
const DROP_LEGACY = process.argv.includes('--drop-legacy');

const OBJECT_TYPES = [
  'Lead',
  'Contact',
  'Account',
  'Ticket',
  'Task',
  'Deal',
  'Conversation',
] as const;

type ObjectType = (typeof OBJECT_TYPES)[number];

const STRATEGIES = [
  'round-robin',
  'least-busy',
  'capacity-based',
  'manual',
] as const;

/** Legacy operator sets differed; only `starts_with` needs no rename. */
const OPERATOR_ALIASES: Record<string, string> = {
  equals: 'eq',
  not_equals: 'neq',
  greater_than: 'gt',
  less_than: 'lt',
};

const stats: Record<string, number> = {};

function bump(key: string, by = 1): void {
  stats[key] = (stats[key] ?? 0) + by;
}

function normalizeStrategy(value: unknown, fallback = 'round-robin'): string {
  if (typeof value !== 'string' || !value) return fallback;
  const lowered = value.toLowerCase();
  if ((STRATEGIES as readonly string[]).includes(lowered)) return lowered;
  const legacy: Record<string, string> = {
    round_robin: 'round-robin',
    least_busy: 'least-busy',
    capacity_based: 'capacity-based',
    // `sticky` was a strategy; it is a preference now, so a rule that used it
    // collapses to the fallback and the preference is carried by settings.
    sticky: fallback,
  };
  return legacy[lowered] ?? fallback;
}

function normalizeOperator(value: unknown): string {
  const raw = typeof value === 'string' ? value.toLowerCase() : 'eq';
  return OPERATOR_ALIASES[raw] ?? raw;
}

function toObjectIdOrNull(value: unknown): ObjectId | null {
  if (!value) return null;
  const str = String(value);
  return ObjectId.isValid(str) ? new ObjectId(str) : null;
}

/**
 * Collapse every legacy `actions` shape into the canonical one.
 *
 * `groupId` and `groupIds` are merged into one ordered chain, deduplicated —
 * both fields existed on `routing_rules` and callers had to reconcile them,
 * which is how one of them kept getting ignored.
 */
function normalizeActions(raw: any): Document {
  const actions = raw ?? {};
  const chain = [
    actions.groupId,
    actions.assignToGroupId,
    ...(Array.isArray(actions.groupIds) ? actions.groupIds : []),
  ]
    .map(toObjectIdOrNull)
    .filter((v): v is ObjectId => v !== null);

  const seen = new Set<string>();
  const groupIds = chain.filter((id) => {
    const key = id.toHexString();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    userId: toObjectIdOrNull(actions.userId ?? actions.assignToUserId),
    groupIds,
    strategy: actions.strategy
      ? normalizeStrategy(actions.strategy, 'round-robin')
      : null,
    requiredSkills: Array.isArray(actions.requiredSkills)
      ? actions.requiredSkills.map((s: unknown) => String(s))
      : [],
  };
}

function normalizeConditions(raw: unknown): Document[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c: any) => ({
    field: String(c?.field ?? ''),
    operator: normalizeOperator(c?.operator),
    value: c?.value === undefined || c?.value === null ? '' : String(c.value),
  }));
}

// ── Step 1+2: rules ────────────────────────────────────────────────────────

/**
 * Ensure a rule name is unique within (tenant, objectType).
 *
 * The two source collections were namespaced separately, so a tenant can have a
 * `routing_rules` and an `assignment_rules` entry with the same name that now
 * collide under a unique index. Suffixing is better than failing the migration
 * or silently dropping one.
 */
async function uniqueName(
  target: Db,
  tenantId: ObjectId,
  objectType: string,
  desired: string,
  selfId: ObjectId,
): Promise<string> {
  const col = target.collection('assignment_rules');
  let candidate = desired;
  for (let attempt = 1; attempt <= 50; attempt++) {
    const clash = await col.findOne({
      tenantId,
      objectType,
      name: candidate,
      _id: { $ne: selfId },
    });
    if (!clash) return candidate;
    candidate = `${desired} (${attempt + 1})`;
  }
  return `${desired} (${selfId.toHexString().slice(-6)})`;
}

async function migrateRoutingRules(db: Db): Promise<void> {
  const source = db.collection('routing_rules');
  const target = db.collection('assignment_rules');

  if (!(await collectionExists(db, 'routing_rules'))) {
    console.log('  routing_rules: absent — nothing to migrate');
    return;
  }

  const cursor = source.find({});
  for await (const rule of cursor) {
    const tenantId = toObjectIdOrNull(rule.tenantId);
    if (!tenantId) {
      console.warn(
        `  ! routing rule ${rule._id} has no valid tenantId — skipped`,
      );
      bump('rules.skipped');
      continue;
    }

    // Re-use the source _id so a re-run updates instead of duplicating.
    const existing = await target.findOne({ _id: rule._id });
    if (
      existing?.objectType === 'Conversation' &&
      existing?.actions?.groupIds
    ) {
      bump('rules.conversation.alreadyMigrated');
      continue;
    }

    const name = await uniqueName(
      db,
      tenantId,
      'Conversation',
      String(rule.name ?? 'Imported routing rule'),
      rule._id as ObjectId,
    );

    const doc: Document = {
      _id: rule._id,
      tenantId,
      objectType: 'Conversation',
      name,
      description: rule.description ?? null,
      priority: typeof rule.priority === 'number' ? rule.priority : 0,
      matchType: rule.matchType === 'any' ? 'any' : 'all',
      conditions: normalizeConditions(rule.conditions),
      actions: normalizeActions(rule.actions),
      enabled: rule.enabled !== false,
      createdAt: rule.createdAt ?? new Date(),
      updatedAt: new Date(),
    };

    if (!DRY_RUN) {
      await target.replaceOne({ _id: rule._id }, doc, { upsert: true });
    }
    bump('rules.conversation.migrated');
  }

  console.log(
    `  routing_rules → assignment_rules{Conversation}: ${stats['rules.conversation.migrated'] ?? 0} migrated, ` +
      `${stats['rules.conversation.alreadyMigrated'] ?? 0} already done`,
  );
}

async function reshapeLegacyRecordRules(db: Db): Promise<void> {
  const col = db.collection('assignment_rules');
  // Only documents that still carry the old `module` field need reshaping.
  const cursor = col.find({ module: { $exists: true } });

  for await (const rule of cursor) {
    const tenantId = toObjectIdOrNull(rule.tenantId);
    if (!tenantId) {
      bump('rules.skipped');
      continue;
    }

    const rawModule = String(rule.module);
    const objectType = (OBJECT_TYPES as readonly string[]).includes(rawModule)
      ? (rawModule as ObjectType)
      : null;

    if (!objectType) {
      console.warn(
        `  ! assignment rule ${rule._id} has unknown module "${rawModule}" — left untouched for manual review`,
      );
      bump('rules.record.unknownModule');
      continue;
    }

    const name = await uniqueName(
      db,
      tenantId,
      objectType,
      String(rule.name ?? 'Imported assignment rule'),
      rule._id as ObjectId,
    );

    if (!DRY_RUN) {
      await col.updateOne(
        { _id: rule._id },
        {
          $set: {
            tenantId,
            objectType,
            name,
            priority: typeof rule.priority === 'number' ? rule.priority : 0,
            matchType: rule.matchType === 'any' ? 'any' : 'all',
            conditions: normalizeConditions(rule.conditions),
            actions: normalizeActions(rule.actions),
            enabled: rule.enabled !== false,
            updatedAt: new Date(),
          },
          $unset: { module: '' },
        },
      );
    }
    bump('rules.record.reshaped');
  }

  console.log(
    `  assignment_rules (legacy shape): ${stats['rules.record.reshaped'] ?? 0} reshaped, ` +
      `${stats['rules.record.unknownModule'] ?? 0} left for review`,
  );
}

// ── Step 3+4+5: settings ───────────────────────────────────────────────────

/** Defaults matching AssignmentSeederService, so a tenant with no legacy config still gets a row. */
function seedDefaults(objectType: ObjectType): Document {
  if (objectType === 'Conversation') {
    return {
      autoAssignEnabled: true,
      defaultStrategy: 'round-robin',
      defaultGroupId: null,
      defaultMaxCapacity: 10,
      fallbackOwnerId: null,
      fallbackStrategy: 'least-busy',
      skillBasedRoutingEnabled: false,
      requireOnline: true,
      preferPreviousAssignee: false,
      previousAssigneeTimeoutHours: 72,
      previousAssigneeWaitMinutes: 3,
    };
  }
  const capacity =
    objectType === 'Lead' ||
    objectType === 'Contact' ||
    objectType === 'Account'
      ? 50
      : 25;
  return {
    autoAssignEnabled: false,
    defaultStrategy: 'round-robin',
    defaultGroupId: null,
    defaultMaxCapacity: capacity,
    fallbackOwnerId: null,
    fallbackStrategy: 'round-robin',
    skillBasedRoutingEnabled: false,
    requireOnline: false,
    preferPreviousAssignee: false,
    previousAssigneeTimeoutHours: 72,
    previousAssigneeWaitMinutes: 0,
  };
}

/** `omni_presence.requireOnlineForAssignment` used lowercase module keys. */
const PRESENCE_KEY: Record<string, string> = {
  Ticket: 'ticket',
  Task: 'task',
  Deal: 'deal',
  Contact: 'contact',
  Lead: 'contact',
  Account: 'contact',
};

async function migrateSettings(db: Db): Promise<void> {
  const tenants = await db.collection('tenants').find({}).toArray();
  const crmSettings = db.collection('crm_settings');
  const legacy = db.collection('assignment_settings');

  for (const tenant of tenants) {
    const tenantId = tenant._id as ObjectId;

    const omniRouting = await crmSettings.findOne({
      tenantId,
      key: 'omni_routing',
    });
    const omniPresence = await crmSettings.findOne({
      tenantId,
      key: 'omni_presence',
    });
    const requireOnlineMap =
      (omniPresence?.value ?? omniPresence?.data)?.requireOnlineForAssignment ??
      {};
    const routing = omniRouting?.value ?? omniRouting?.data ?? {};

    for (const objectType of OBJECT_TYPES) {
      const defaults = seedDefaults(objectType);
      const patch: Document = { ...defaults };

      if (objectType === 'Conversation') {
        // Every routing-decision field moves out of omni_routing.
        if (routing.autoAssignmentEnabled !== undefined) {
          patch.autoAssignEnabled = routing.autoAssignmentEnabled !== false;
        }
        if (routing.defaultStrategy !== undefined) {
          patch.defaultStrategy = normalizeStrategy(routing.defaultStrategy);
        }
        if (typeof routing.defaultMaxCapacity === 'number') {
          patch.defaultMaxCapacity = routing.defaultMaxCapacity;
        }
        if (routing.fallbackStrategy !== undefined) {
          patch.fallbackStrategy = normalizeStrategy(
            routing.fallbackStrategy,
            'least-busy',
          );
        }
        if (routing.skillBasedRoutingEnabled !== undefined) {
          patch.skillBasedRoutingEnabled = Boolean(
            routing.skillBasedRoutingEnabled,
          );
        }
        if (routing.stickyRoutingEnabled !== undefined) {
          patch.preferPreviousAssignee = Boolean(routing.stickyRoutingEnabled);
        }
        if (typeof routing.stickyTimeoutHours === 'number') {
          patch.previousAssigneeTimeoutHours = routing.stickyTimeoutHours;
        }
        if (typeof routing.stickyWaitTimeMinutes === 'number') {
          patch.previousAssigneeWaitMinutes = routing.stickyWaitTimeMinutes;
        }
        // The old conversation engine had no presence gate of its own — it only
        // ever routed over online agents — so `requireOnline` stays true.
      } else {
        const legacyDoc = await legacy.findOne({
          tenantId,
          $or: [{ module: objectType }, { objectType }],
        });
        if (legacyDoc) {
          if (legacyDoc.autoAssignEnabled !== undefined) {
            patch.autoAssignEnabled = Boolean(legacyDoc.autoAssignEnabled);
          }
          patch.defaultStrategy = normalizeStrategy(legacyDoc.defaultStrategy);
          if (typeof legacyDoc.defaultMaxCapacity === 'number') {
            patch.defaultMaxCapacity = legacyDoc.defaultMaxCapacity;
          }
          patch.defaultGroupId = toObjectIdOrNull(legacyDoc.defaultGroupId);
          patch.fallbackOwnerId = toObjectIdOrNull(legacyDoc.fallbackOwnerId);
          if (legacyDoc.prioritizeCurrentOwner !== undefined) {
            patch.preferPreviousAssignee = Boolean(
              legacyDoc.prioritizeCurrentOwner,
            );
          }
        }

        // Pull the presence gate out of omni_presence, where an assignment
        // setting had no business living.
        const key = PRESENCE_KEY[objectType];
        if (key && typeof requireOnlineMap[key] === 'boolean') {
          patch.requireOnline = requireOnlineMap[key];
        }
      }

      if (!DRY_RUN) {
        await legacy.updateOne(
          { tenantId, objectType },
          {
            $set: { ...patch, updatedAt: new Date() },
            $setOnInsert: { tenantId, objectType, createdAt: new Date() },
            // The legacy record rows carried `module`, plus two settings that
            // were never enforced. Drop them now that the key is `objectType`,
            // otherwise the unique index sees two shapes.
            $unset: {
              module: '',
              triggerFields: '',
              respectWorkingHours: '',
              prioritizeCurrentOwner: '',
            },
          },
          { upsert: true },
        );
      }
      bump('settings.written');
    }

    // Leave omni_routing in place but strip the fields that moved, so nothing
    // reads a stale copy of a value the assignment core now owns.
    if (!DRY_RUN && omniRouting) {
      const valueField = omniRouting.value !== undefined ? 'value' : 'data';
      await crmSettings.updateOne(
        { _id: omniRouting._id },
        {
          $unset: {
            [`${valueField}.autoAssignmentEnabled`]: '',
            [`${valueField}.defaultStrategy`]: '',
            [`${valueField}.defaultMaxCapacity`]: '',
            [`${valueField}.stickyRoutingEnabled`]: '',
            [`${valueField}.stickyTimeoutHours`]: '',
            [`${valueField}.stickyWaitTimeMinutes`]: '',
            [`${valueField}.fallbackStrategy`]: '',
            [`${valueField}.skillBasedRoutingEnabled`]: '',
          },
        },
      );
      bump('settings.omniRoutingPruned');
    }
  }

  console.log(
    `  settings: ${stats['settings.written'] ?? 0} rows written across ${tenants.length} tenant(s), ` +
      `${stats['settings.omniRoutingPruned'] ?? 0} omni_routing docs pruned`,
  );
}

// ── Step 6: audit log ──────────────────────────────────────────────────────

async function flushAudit(
  target: ReturnType<Db['collection']>,
  batch: Document[],
): Promise<void> {
  if (DRY_RUN) return;
  await target.bulkWrite(
    batch.map((doc) => ({
      replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
    })),
    { ordered: false },
  );
}

async function migrateAuditLogs(db: Db): Promise<void> {
  if (!(await collectionExists(db, 'omni_assignment_audit_logs'))) {
    console.log('  omni_assignment_audit_logs: absent — nothing to migrate');
    return;
  }

  const source = db.collection('omni_assignment_audit_logs');
  const target = db.collection('assignment_audit_logs');
  const BATCH = 500;
  let batch: Document[] = [];

  const cursor = source.find({});
  for await (const row of cursor) {
    const tenantId = toObjectIdOrNull(row.tenantId);
    if (!tenantId) {
      bump('audit.skipped');
      continue;
    }

    const outcome = ['assigned', 'queued', 'failed'].includes(row.outcome)
      ? row.outcome
      : 'queued';

    batch.push({
      _id: row._id,
      tenantId,
      objectType: 'Conversation',
      entityId: String(row.conversationId ?? 'unknown'),
      assigneeId: toObjectIdOrNull(row.assignedAgentId),
      previousAssigneeId: toObjectIdOrNull(row.previousAgentId),
      groupId: toObjectIdOrNull(row.metadata?.owningGroupId),
      ruleId: row.ruleId ?? null,
      ruleName: row.ruleName ?? null,
      strategy: String(row.strategy ?? 'unknown'),
      outcome,
      reason: String(row.reason ?? ''),
      reasonKey: row.reasonKey ?? null,
      reasonParams: row.reasonParams ?? null,
      source: row.metadata?.isManual ? 'manual' : 'inbound',
      sourceWorkflowId: null,
      performedByUserId: toObjectIdOrNull(row.metadata?.performedByUserId),
      channelType: row.channelType ?? null,
      candidatePoolSize: row.agentPoolSize ?? 0,
      eligiblePoolSize: row.eligiblePoolSize ?? 0,
      metadata: row.metadata ?? {},
      createdAt: row.createdAt ?? new Date(),
      updatedAt: row.updatedAt ?? row.createdAt ?? new Date(),
    });

    if (batch.length >= BATCH) {
      await flushAudit(target, batch);
      bump('audit.migrated', batch.length);
      batch = [];
    }
  }

  if (batch.length > 0) {
    await flushAudit(target, batch);
    bump('audit.migrated', batch.length);
  }

  console.log(
    `  omni_assignment_audit_logs → assignment_audit_logs: ${stats['audit.migrated'] ?? 0} rows`,
  );
}

// ── Step 7: skills ─────────────────────────────────────────────────────────

/**
 * Strip the combining marks NFD leaves behind, and map the one Vietnamese
 * letter NFD does not decompose.
 *
 * Written as an explicit code-point scan rather than a regex character class:
 * a class containing combining marks is both unreadable in source and flagged
 * as a misleading character class by lint.
 */
function stripDiacritics(value: string): string {
  let out = '';
  for (const ch of value.normalize('NFD')) {
    const code = ch.codePointAt(0) ?? 0;
    // U+0300..U+036F — combining diacritical marks.
    if (code >= 0x300 && code <= 0x36f) continue;
    // U+0111 LATIN SMALL LETTER D WITH STROKE.
    out += code === 0x111 ? 'd' : ch;
  }
  return out;
}

/**
 * Derive the canonical apiName for a display name.
 *
 * Diacritics are decomposed and removed rather than filtered out, so
 * "Tieng Anh" with accents becomes `tieng_anh` instead of losing every
 * accented character to the final `[^a-z0-9_]` pass.
 */
export function toSkillApiName(name: string): string {
  return stripDiacritics(name.toLowerCase())
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

/**
 * Rewrite `users.skills` to hold apiNames, creating catalogue entries for names
 * that only ever existed as free text in the omni rule editor.
 *
 * Anything that cannot be reduced to an apiName is reported rather than dropped:
 * a silently discarded skill turns a skill-filtered rule into an unfiltered one.
 */
async function migrateSkills(db: Db): Promise<void> {
  const users = db.collection('users');
  const catalogue = db.collection('assignment_skills');

  const cursor = users.find({
    skills: { $exists: true, $type: 'array', $ne: [] },
  });

  for await (const user of cursor) {
    const tenantId = toObjectIdOrNull(user.tenantId);
    const raw: string[] = Array.isArray(user.skills)
      ? user.skills.map(String)
      : [];
    if (raw.length === 0) continue;

    const resolved: string[] = [];
    for (const value of raw) {
      const apiName = toSkillApiName(value);
      if (!apiName) {
        console.warn(
          `  ! user ${user._id} skill "${value}" cannot be slugged — left as-is for review`,
        );
        bump('skills.unresolvable');
        resolved.push(value);
        continue;
      }

      if (tenantId) {
        const existing = await catalogue.findOne({ tenantId, apiName });
        if (!existing && !DRY_RUN) {
          await catalogue.updateOne(
            { tenantId, apiName },
            {
              $setOnInsert: {
                tenantId,
                apiName,
                name: value,
                category: null,
                description:
                  'Created by the assignment consolidation migration',
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            },
            { upsert: true },
          );
          bump('skills.catalogueCreated');
        }
      }
      resolved.push(apiName);
    }

    const deduped = [...new Set(resolved)];
    const changed =
      deduped.length !== raw.length || deduped.some((v, i) => v !== raw[i]);
    if (changed) {
      if (!DRY_RUN) {
        await users.updateOne({ _id: user._id }, { $set: { skills: deduped } });
      }
      bump('skills.usersRewritten');
    }
  }

  // Rules reference skills too — rewrite their requiredSkills the same way.
  const rules = db.collection('assignment_rules');
  const ruleCursor = rules.find({
    'actions.requiredSkills.0': { $exists: true },
  });
  for await (const rule of ruleCursor) {
    const raw: string[] = rule.actions?.requiredSkills ?? [];
    const mapped = [
      ...new Set(raw.map((s) => toSkillApiName(String(s)) || String(s))),
    ];
    const changed =
      mapped.length !== raw.length || mapped.some((v, i) => v !== raw[i]);
    if (changed) {
      if (!DRY_RUN) {
        await rules.updateOne(
          { _id: rule._id },
          { $set: { 'actions.requiredSkills': mapped } },
        );
      }
      bump('skills.rulesRewritten');
    }
  }

  console.log(
    `  skills: ${stats['skills.usersRewritten'] ?? 0} users, ` +
      `${stats['skills.rulesRewritten'] ?? 0} rules, ` +
      `${stats['skills.catalogueCreated'] ?? 0} catalogue entries created, ` +
      `${stats['skills.unresolvable'] ?? 0} unresolvable`,
  );
}

// ── Indexes ────────────────────────────────────────────────────────────────

/**
 * Drop indexes belonging to the retired shapes.
 *
 * The old unique index was `{tenantId, module, name}`; leaving it in place would
 * reject two rules with the same name for different objectTypes even though the
 * new index permits it, and it can never be satisfied once `module` is unset.
 */
async function dropStaleIndexes(db: Db): Promise<void> {
  const drops: Array<[string, string]> = [
    ['assignment_rules', 'tenantId_1_module_1_name_1'],
    ['assignment_rules', 'tenantId_1_module_1_priority_1'],
    ['assignment_rules', 'tenantId_1_module_1_enabled_1'],
    ['assignment_settings', 'tenantId_1_module_1'],
    ['assignment_audit_logs', 'tenantId_1_module_1_entityId_1'],
  ];

  for (const [collection, index] of drops) {
    if (!(await collectionExists(db, collection))) continue;
    try {
      if (!DRY_RUN) await db.collection(collection).dropIndex(index);
      console.log(`  dropped index ${collection}.${index}`);
      bump('indexes.dropped');
    } catch {
      // Absent already — the desired end state.
    }
  }
}

async function collectionExists(db: Db, name: string): Promise<boolean> {
  const found = await db.listCollections({ name }).toArray();
  return found.length > 0;
}

// ── Legacy cleanup ─────────────────────────────────────────────────────────

async function dropLegacyCollections(db: Db): Promise<void> {
  const legacy = ['routing_rules', 'omni_assignment_audit_logs'];
  for (const name of legacy) {
    if (!(await collectionExists(db, name))) continue;
    const count = await db.collection(name).countDocuments();
    if (!DRY_RUN) await db.collection(name).drop();
    console.log(`  dropped ${name} (${count} documents)`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    console.log(
      `Connected. Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY'}${
        DROP_LEGACY ? ' + DROP LEGACY' : ''
      }\n`,
    );

    console.log('1/7  Rules — routing_rules → assignment_rules{Conversation}');
    await migrateRoutingRules(db);

    console.log('\n2/7  Rules — reshaping legacy record rules');
    await reshapeLegacyRecordRules(db);

    console.log(
      '\n3/7  Settings — omni_routing + assignment_settings + omni_presence',
    );
    await migrateSettings(db);

    console.log(
      '\n4/7  Audit — omni_assignment_audit_logs → assignment_audit_logs',
    );
    await migrateAuditLogs(db);

    console.log(
      '\n5/7  Skills — user.skills and rule requiredSkills → apiNames',
    );
    await migrateSkills(db);

    console.log('\n6/7  Indexes — dropping retired shapes');
    await dropStaleIndexes(db);

    console.log('\n7/7  Legacy collections');
    if (DROP_LEGACY) {
      await dropLegacyCollections(db);
    } else {
      console.log(
        '  kept (pass --drop-legacy once the migrated data has been verified)',
      );
    }

    console.log('\n=== Summary ===');
    for (const [key, value] of Object.entries(stats).sort()) {
      console.log(`  ${key}: ${value}`);
    }
    if (DRY_RUN) {
      console.log('\nDRY RUN — nothing was written.');
    }
  } catch (error) {
    console.error(
      '\nMigration failed:',
      error instanceof Error ? error.stack : error,
    );
    process.exit(1);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
