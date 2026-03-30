import { MongoClient } from 'mongodb';

const url = 'mongodb+srv://nguyentoan102002_db_user:Xq0t6ZsieMIelTiz@crm.sfh1nlk.mongodb.net/crm?appName=crm';

async function main() {
  const client = new MongoClient(url);
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    const db = client.db('crm');

    // 1. Fix Channels
    let res = await db.collection('channels').updateMany(
      { tenant: { $exists: true } },
      { $rename: { 'tenant': 'tenantId' } }
    );
    console.log(`Updated ${res.modifiedCount} channels.`);

    // 2. Fix OmniMessages
    res = await db.collection('omni_messages').updateMany(
      { tenant: { $exists: true } },
      { $rename: { 
          'tenant': 'tenantId', 
          'conversation': 'conversationId', 
          'contact': 'contactId', 
          'sendToDevice': 'sendToDeviceId', 
          'channel': 'channelId', 
          'assignedTo': 'assignedToId' 
        } 
      }
    );
    console.log(`Updated ${res.modifiedCount} omni_messages.`);

    // 3. Fix OmniConversations
    res = await db.collection('omni_conversations').updateMany(
      { tenant: { $exists: true } },
      { $rename: { 
          'tenant': 'tenantId', 
          'contact': 'contactId', 
          'assignee': 'assignedToId',
          'channel': 'channelId'
        } 
      }
    );
    console.log(`Updated ${res.modifiedCount} omni_conversations.`);

    // 4. Fix Tasks
    res = await db.collection('tasks').updateMany(
      { tenant: { $exists: true } },
      { $rename: { 'tenant': 'tenantId', 'assignedTo': 'assignedToId' } }
    );
    console.log(`Updated ${res.modifiedCount} tasks.`);

    // 5. Fix Users (Array elements)
    // Note: To rename a field inside an array of objects, we use the all-positional operator $[]
    res = await db.collection('users').updateMany(
      { "tenants.tenant": { $exists: true } },
      { $rename: { "tenants.$[].tenant": "tenants.$[].tenantId" } }
    );
    console.log(`Updated ${res.modifiedCount} users.`);

    // 6. Fix Omni Conversation Activities
    res = await db.collection('omni_conversation_activities').updateMany(
      { tenant: { $exists: true } },
      { $rename: { 'tenant': 'tenantId' } }
    );
    console.log(`Updated ${res.modifiedCount} omni_conversation_activities.`);

    // 7. Fix Tickets (if applicable)
    res = await db.collection('tickets').updateMany(
      { tenant: { $exists: true } },
      { $rename: { 'tenant': 'tenantId', 'assignedTo': 'assignedToId', 'contact': 'contactId', 'company': 'companyId' } }
    );
    console.log(`Updated ${res.modifiedCount} tickets.`);

  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await client.close();
    console.log('Migration complete. You can now delete this script.');
  }
}

main().catch(console.error);
