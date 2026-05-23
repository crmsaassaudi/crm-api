const { MongoClient, ObjectId } = require('mongodb');

const uri = 'mongodb+srv://nguyentoan102002_db_user:Xq0t6ZsieMIelTiz@crm.sfh1nlk.mongodb.net/crm?appName=crm';

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
