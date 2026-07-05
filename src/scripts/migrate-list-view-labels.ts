/**
 * Migration Script: Clean list_views data.
 *
 * Fixes TWO issues:
 * 1. Strips hardcoded English `label` from columns (labels are now i18n on frontend)
 * 2. Fixes localized module names (e.g. "Liên hệ" → "Contact") — a frontend bug
 *    previously sent the localized name instead of the system key.
 *
 * IDEMPOTENT: Safe to run multiple times.
 *
 * USAGE:
 *   npm run migrate:list-view-labels
 */

import 'dotenv/config';
import { MongoClient } from 'mongodb';

const VALID_MODULES = ['Contact', 'Account', 'Deal', 'Ticket', 'Task'];

/**
 * Reverse lookup: localized module name → system key.
 * Add more translations as needed for other locales.
 */
const LOCALIZED_MODULE_MAP: Record<string, string> = {
  // Vietnamese
  'liên hệ': 'Contact',
  'tài khoản': 'Account',
  'giao dịch': 'Deal',
  'phiếu hỗ trợ': 'Ticket',
  'công việc': 'Task',
  // Arabic
  'جهة اتصال': 'Contact',
  حساب: 'Account',
  صفقة: 'Deal',
  تذكرة: 'Ticket',
  مهمة: 'Task',
};

function resolveModule(module: string): string | null {
  if (VALID_MODULES.includes(module)) return module;
  return LOCALIZED_MODULE_MAP[module.toLowerCase()] ?? null;
}

// ── Per-view helpers ───────────────────────────────────────────────

interface ViewPatchResult {
  deleted: boolean;
  modulesFixed: number;
  labelsStripped: number;
  dirty: boolean;
}

/** Fix module name on a single view. Returns true if the view should be deleted. */
function fixViewModule(view: any): {
  deleted: boolean;
  fixed: boolean;
  dirty: boolean;
} {
  const resolved = resolveModule(view.module);
  if (!resolved) {
    console.log(
      `    ⚠ Deleting orphaned view "${view.name}" with unknown module "${view.module}"`,
    );
    return { deleted: true, fixed: false, dirty: true };
  }
  if (resolved !== view.module) {
    console.log(
      `    → Fixed module: "${view.module}" → "${resolved}" (view: "${view.name}")`,
    );
    view.module = resolved;
    return { deleted: false, fixed: true, dirty: true };
  }
  return { deleted: false, fixed: false, dirty: false };
}

/** Strip labels from all columns of a single view. Returns number of labels removed. */
function stripColumnLabels(view: any): number {
  if (!Array.isArray(view.columns)) return 0;
  let stripped = 0;
  for (const column of view.columns) {
    if (column.label !== undefined) {
      delete column.label;
      stripped++;
    }
  }
  return stripped;
}

/** Process all views (module fix + label strip). Returns patch counts. */
function processViews(views: any[]): Omit<ViewPatchResult, 'deleted'> {
  let labelsStripped = 0;
  let modulesFixed = 0;
  let dirty = false;

  for (let i = views.length - 1; i >= 0; i--) {
    const view = views[i];

    const { deleted, fixed, dirty: modDirty } = fixViewModule(view);
    if (deleted) {
      views.splice(i, 1);
      dirty = true;
      continue;
    }
    if (fixed) modulesFixed++;
    if (modDirty) dirty = true;

    const stripped = stripColumnLabels(view);
    if (stripped > 0) {
      labelsStripped += stripped;
      dirty = true;
    }
  }

  return { labelsStripped, modulesFixed, dirty };
}

/** Deduplicate views keeping the first occurrence per module+name (case-insensitive). */
function deduplicateViews(views: any[]): { removed: number; dirty: boolean } {
  const seen = new Set<string>();
  let removed = 0;
  let dirty = false;

  for (let i = views.length - 1; i >= 0; i--) {
    const key = `${views[i].module.toLowerCase()}::${views[i].name.toLowerCase()}`;
    if (seen.has(key)) {
      console.log(
        `    ✂ Removing duplicate view "${views[i].name}" (module: ${views[i].module}, id: ${views[i].id})`,
      );
      views.splice(i, 1);
      removed++;
      dirty = true;
    } else {
      seen.add(key);
    }
  }

  return { removed, dirty };
}

// ── Main migration ─────────────────────────────────────────────────

async function migrateListViews() {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db();
    const collection = db.collection('crm_settings');

    const docs = await collection.find({ key: 'list_views' }).toArray();
    console.log(`Found ${docs.length} tenant(s) with list_views settings\n`);

    let totalTenantsUpdated = 0;
    let totalLabelsStripped = 0;
    let totalModulesFixed = 0;
    let totalViewsDeleted = 0;
    let totalDuplicatesRemoved = 0;

    for (const doc of docs) {
      const views = doc.value?.views;
      if (!Array.isArray(views)) {
        console.log(`  Tenant ${doc.tenantId}: no views array, skipping`);
        continue;
      }

      const initialCount = views.length;
      const {
        labelsStripped,
        modulesFixed,
        dirty: processDirty,
      } = processViews(views);
      const viewsDeleted = initialCount - views.length;

      const { removed: duplicatesRemoved, dirty: dedupDirty } =
        deduplicateViews(views);
      const dirty = processDirty || dedupDirty;

      if (dirty) {
        await collection.updateOne(
          { _id: doc._id },
          { $set: { 'value.views': views } },
        );
        totalTenantsUpdated++;
        totalLabelsStripped += labelsStripped;
        totalModulesFixed += modulesFixed;
        totalViewsDeleted += viewsDeleted;
        totalDuplicatesRemoved += duplicatesRemoved;
        console.log(
          `  Tenant ${doc.tenantId}: labels=${labelsStripped}, modules_fixed=${modulesFixed}, deleted=${viewsDeleted}, duplicates=${duplicatesRemoved}`,
        );
      } else {
        console.log(`  Tenant ${doc.tenantId}: already clean`);
      }
    }

    console.log('\n=== Migration Complete ===');
    console.log(`Tenants processed: ${docs.length}`);
    console.log(`Tenants updated: ${totalTenantsUpdated}`);
    console.log(`Labels stripped: ${totalLabelsStripped}`);
    console.log(`Modules fixed: ${totalModulesFixed}`);
    console.log(`Orphaned views deleted: ${totalViewsDeleted}`);
    console.log(`Duplicates removed: ${totalDuplicatesRemoved}`);
  } catch (error) {
    console.error(
      'Migration failed:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  } finally {
    await client.close();
  }
}

migrateListViews().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
