const { MongoClient } = require('mongodb');

const uri = process.env.DATABASE_URL;
if (!uri) {
  console.error('❌ DATABASE_URL env var is required.');
  process.exit(1);
}

async function main() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('crm');

    const r1 = await db.collection('email_contents').deleteMany({});
    console.log(`email_contents: deleted ${r1.deletedCount}`);

    const r2 = await db.collection('email_metadata').deleteMany({});
    console.log(`email_metadata: deleted ${r2.deletedCount}`);

    const r3 = await db.collection('omni_conversations').deleteMany({ channelType: 'Email' });
    console.log(`omni_conversations (Email): deleted ${r3.deletedCount}`);

    const r4 = await db.collection('omni_messages').deleteMany({});
    console.log(`omni_messages: deleted ${r4.deletedCount}`);

    const r5 = await db.collection('contacts').deleteMany({ isShadow: true });
    console.log(`contacts (all shadow): deleted ${r5.deletedCount}`);

    console.log('✅ Cleanup complete');
  } finally {
    await client.close();
  }
}

main().catch(console.error);
