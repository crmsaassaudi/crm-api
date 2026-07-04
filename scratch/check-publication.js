const { MongoClient, ObjectId } = require('mongodb');

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

    const instanceId = '6a11cb88a2b099e154b7303a';
    const instance = await db.collection('publication_instances').findOne({ _id: new ObjectId(instanceId) });

    if (!instance) {
      console.log(`❌ Publication instance ${instanceId} not found in collection publication_instances!`);
      return;
    }

    console.log('✅ Found publication instance:');
    console.log(JSON.stringify(instance, null, 2));

  } finally {
    await client.close();
  }
}

main().catch(console.error);
