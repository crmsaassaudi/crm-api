/**
 * Migration Script: Strip hardcoded labels from list_views columns.
 *
 * WHY:
 * List view column labels were previously hardcoded in English (e.g. "Name", "Owner").
 * The frontend now resolves labels via i18n at render time using the column `key`.
 * Storing labels in the DB is redundant and breaks multi-language support.
 *
 * WHAT IT DOES:
 * 1. Finds all crm_settings documents with key = 'list_views'
 * 2. For each tenant's views, removes the `label` field from every column
 * 3. Writes back the cleaned data
 *
 * IDEMPOTENT: Safe to run multiple times. If no labels found, nothing changes.
 *
 * USAGE:
 *   DATABASE_URL=mongodb://... npx ts-node src/scripts/migrate-list-view-labels.ts
 */

import 'dotenv/config';
import { MongoClient } from 'mongodb';

async function migrateListViewLabels() {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log('Connected to MongoDB');

    const db = client.db();
    const collection = db.collection('crm_settings');

    // Find all list_views settings across all tenants
    const docs = await collection
      .find({ key: 'list_views' })
      .toArray();

    console.log(`Found ${docs.length} tenant(s) with list_views settings`);

    let totalTenantsUpdated = 0;
    let totalLabelsStripped = 0;

    for (const doc of docs) {
      const views = doc.value?.views;
      if (!Array.isArray(views)) {
        console.log(`  Tenant ${doc.tenantId}: no views array, skipping`);
        continue;
      }

      let labelsInThisTenant = 0;

      for (const view of views) {
        if (!Array.isArray(view.columns)) continue;

        for (const column of view.columns) {
          if (column.label !== undefined) {
            delete column.label;
            labelsInThisTenant++;
          }
        }
      }

      if (labelsInThisTenant > 0) {
        await collection.updateOne(
          { _id: doc._id },
          { $set: { 'value.views': views } },
        );
        totalTenantsUpdated++;
        totalLabelsStripped += labelsInThisTenant;
        console.log(
          `  Tenant ${doc.tenantId}: stripped ${labelsInThisTenant} labels from ${views.length} views`,
        );
      } else {
        console.log(`  Tenant ${doc.tenantId}: no labels to strip (already clean)`);
      }
    }

    console.log('\n=== Migration Complete ===');
    console.log(`Tenants processed: ${docs.length}`);
    console.log(`Tenants updated: ${totalTenantsUpdated}`);
    console.log(`Total labels stripped: ${totalLabelsStripped}`);
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

migrateListViewLabels().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
