/**
 * Give the owner workspace every navigation item, for tenants already seeded.
 *
 * The seeded layout used to hand the owner a curated oversight menu — reports,
 * forecast, settings — so the person accountable for the whole workspace had to
 * switch workspaces to reach the modules they own. The default now includes
 * everything, but seeding never overwrites an existing value, so tenants
 * created before this change keep the short menu.
 *
 *   npm run migrate:owner-workspace-all-modules -- --dry-run
 *   npm run migrate:owner-workspace-all-modules
 *
 * Purely additive: it adds the owner workspace id to items that lack it and
 * touches nothing else. An item a tenant deleted outright stays deleted — it is
 * absent from `items`, and this script never invents rows. An item a tenant
 * deliberately removed *from the owner workspace* WILL come back, which is the
 * one case worth knowing about before running it; the log names every item it
 * changes, per tenant.
 *
 * Idempotent: a second run reports zero changes. Safe to rerun.
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const SETTING_KEY = 'navigation_workspaces';
const OWNER_WORKSPACE_ID = 'owner';

interface ItemRow {
  itemId: string;
  workspaces?: string[];
  order?: number;
  hidden?: boolean;
}

async function main(): Promise<void> {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const dryRun = process.argv.includes('--dry-run');
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const settings = client.db().collection('crm_settings');

    const rows = await settings.find({ key: SETTING_KEY }).toArray();

    console.log(
      `${rows.length} tenant navigation setting(s) found` +
        (dryRun ? ' — DRY RUN, nothing will be written.' : ''),
    );

    let touched = 0;

    for (const row of rows) {
      const value = (row as any).value ?? {};
      const workspaces: { id?: string }[] = value.workspaces ?? [];
      const items: ItemRow[] = value.items ?? [];

      // A tenant that renamed or removed the owner workspace has answered this
      // question for itself; adding an id nothing declares would only produce a
      // layout the API refuses to save.
      if (
        !workspaces.some((workspace) => workspace?.id === OWNER_WORKSPACE_ID)
      ) {
        console.log(
          `  ${row.tenantId}: no "${OWNER_WORKSPACE_ID}" workspace declared — skipped`,
        );
        continue;
      }

      const added: string[] = [];
      const nextItems = items.map((item) => {
        const current = item.workspaces ?? [];
        if (current.includes(OWNER_WORKSPACE_ID)) return item;
        added.push(item.itemId);
        return { ...item, workspaces: [...current, OWNER_WORKSPACE_ID] };
      });

      if (added.length === 0) continue;

      console.log(`  ${row.tenantId}: +owner on ${added.join(', ')}`);
      if (!dryRun) {
        await settings.updateOne(
          { _id: row._id },
          { $set: { 'value.items': nextItems } },
        );
      }
      touched += 1;
    }

    console.log(
      `${touched} tenant(s) ${dryRun ? 'would be updated' : 'updated'}.`,
    );
  } finally {
    await client.close();
  }
}

void main();
