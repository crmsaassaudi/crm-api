import 'dotenv/config';
import { createHash } from 'crypto';
import { MongoClient, ObjectId } from 'mongodb';

const BATCH_SIZE = 500;

function stableEventId(contactId: ObjectId, entry: any, index: number): string {
  return createHash('sha256')
    .update(
      [
        String(contactId),
        index,
        entry.fromStage ?? '',
        entry.toStage ?? '',
        new Date(entry.changedAt).toISOString(),
      ].join(':'),
    )
    .digest('hex');
}

async function main(): Promise<void> {
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error('DATABASE_URL is required');
  const dryRun = process.argv.includes('--dry-run');
  const tenantArg = process.argv
    .slice(2)
    .find((arg) => arg.startsWith('--tenantId='))
    ?.split('=')[1];

  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db();
    const contacts = db.collection('contacts');
    const transitions = db.collection('contact_stage_transitions');
    const filter: Record<string, unknown> = {
      'stageHistory.0': { $exists: true },
      ...(tenantArg ? { tenantId: new ObjectId(tenantArg) } : {}),
    };

    let scanned = 0;
    let projected = 0;
    const cursor = contacts
      .find(filter, { projection: { tenantId: 1, stageHistory: 1 } })
      .sort({ _id: 1 });
    let operations: any[] = [];

    for await (const contact of cursor) {
      scanned++;
      for (const [index, entry] of (contact.stageHistory ?? []).entries()) {
        if (!entry?.toStage || !entry?.changedAt) continue;
        const eventId = stableEventId(contact._id, entry, index);
        operations.push({
          updateOne: {
            filter: { tenantId: contact.tenantId, eventId },
            update: {
              $setOnInsert: {
                tenantId: contact.tenantId,
                contactId: contact._id,
                fromStage: entry.fromStage ?? null,
                toStage: entry.toStage,
                occurredAt: new Date(entry.changedAt),
                changedById: entry.changedById,
                reason: entry.reason,
                direction: entry.direction,
                skippedStages: entry.skippedStages ?? [],
                eventId,
              },
            },
            upsert: true,
          },
        });
      }

      if (operations.length >= BATCH_SIZE) {
        if (!dryRun) {
          const result = await transitions.bulkWrite(operations, {
            ordered: false,
          });
          projected += result.upsertedCount;
        } else {
          projected += operations.length;
        }
        operations = [];
      }
    }

    if (operations.length > 0) {
      if (!dryRun) {
        const result = await transitions.bulkWrite(operations, {
          ordered: false,
        });
        projected += result.upsertedCount;
      } else {
        projected += operations.length;
      }
    }

    process.stdout.write(
      JSON.stringify({ dryRun, scanned, projected }, null, 2) + '\n',
    );
  } finally {
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
