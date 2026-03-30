import { MongoClient, ObjectId } from 'mongodb';

const url =
  'mongodb+srv://nguyentoan102002_db_user:Xq0t6ZsieMIelTiz@crm.sfh1nlk.mongodb.net/crm?appName=crm';

async function mapFieldToString(
  db: any,
  collectionName: string,
  fieldName: string,
) {
  const collection = db.collection(collectionName);
  const result = await collection.updateMany(
    { [fieldName]: { $type: 'objectId' } },
    [{ $set: { [fieldName]: { $toString: `$${fieldName}` } } }],
  );
  if (result.modifiedCount > 0) {
    console.log(
      `[${collectionName}] Converted ${result.modifiedCount} ${fieldName} to String.`,
    );
  }
}

async function mapArrayFieldToString(
  db: any,
  collectionName: string,
  arrayField: string,
  objField: string,
) {
  const collection = db.collection(collectionName);

  // Since updateMany with aggregation pipeline doesn't natively map nested arrays easily,
  // we'll do an aggregation pipeline with $map.
  const result = await collection.updateMany(
    { [`${arrayField}.${objField}`]: { $type: 'objectId' } },
    [
      {
        $set: {
          [arrayField]: {
            $map: {
              input: `$${arrayField}`,
              as: 'item',
              in: {
                $mergeObjects: [
                  '$$item',
                  {
                    [objField]: {
                      $cond: {
                        if: {
                          $eq: [{ $type: `$$item.${objField}` }, 'objectId'],
                        },
                        then: { $toString: `$$item.${objField}` },
                        else: `$$item.${objField}`,
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    ],
  );

  if (result.modifiedCount > 0) {
    console.log(
      `[${collectionName}] Converted ${result.modifiedCount} documents' ${arrayField}.${objField} to String.`,
    );
  }
}

async function main() {
  const client = new MongoClient(url);
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    const db = client.db('crm');

    // 1. Channels
    await mapFieldToString(db, 'channels', 'tenantId');

    // 2. OmniMessages
    await mapFieldToString(db, 'omni_messages', 'tenantId');
    await mapFieldToString(db, 'omni_messages', 'conversationId');
    await mapFieldToString(db, 'omni_messages', 'contactId');
    await mapFieldToString(db, 'omni_messages', 'channelId');
    await mapFieldToString(db, 'omni_messages', 'assignedToId');
    await mapFieldToString(db, 'omni_messages', 'sendToDeviceId');

    // 3. OmniConversations
    await mapFieldToString(db, 'omni_conversations', 'tenantId');
    await mapFieldToString(db, 'omni_conversations', 'contactId');
    await mapFieldToString(db, 'omni_conversations', 'assignedToId');
    await mapFieldToString(db, 'omni_conversations', 'channelId');
    await mapFieldToString(db, 'omni_conversations', 'previousConversationId');
    await mapFieldToString(db, 'omni_conversations', 'resolvedByAgentId');

    // 4. Tasks
    await mapFieldToString(db, 'tasks', 'tenantId');
    await mapFieldToString(db, 'tasks', 'assignedToId');

    // 5. Users (Array elements)
    await mapArrayFieldToString(db, 'users', 'tenants', 'tenantId');

    // 6. Omni Conversation Activities
    await mapFieldToString(db, 'omni_conversation_activities', 'tenantId');
    await mapFieldToString(
      db,
      'omni_conversation_activities',
      'conversationId',
    );
    await mapFieldToString(db, 'omni_conversation_activities', 'agentId');

    // 7. Tickets
    await mapFieldToString(db, 'tickets', 'tenantId');
    await mapFieldToString(db, 'tickets', 'assignedToId');
    await mapFieldToString(db, 'tickets', 'contactId');
    await mapFieldToString(db, 'tickets', 'companyId');
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await client.close();
    console.log('Migration complete.');
  }
}

main().catch(console.error);
