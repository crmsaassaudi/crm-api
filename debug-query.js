const { MongoClient } = require('mongodb');

async function run() {
  const c = new MongoClient('mongodb+srv://nguyentoan102002_db_user:Xq0t6ZsieMIelTiz@crm.sfh1nlk.mongodb.net/crm?appName=crm');
  await c.connect();
  const db = c.db('crm');

  // Count all docs
  const total = await db.collection('omni_conversations').countDocuments();
  console.log('Total docs:', total);

  // Count by string tenantId
  const byString = await db.collection('omni_conversations').countDocuments({ tenantId: '69ac2273e7e66e9799f6ffdd' });
  console.log('By string tenantId:', byString);

  // Count by status
  const byStatus = await db.collection('omni_conversations').countDocuments({ status: { $in: ['open', 'pending'] } });
  console.log('By status open/pending:', byStatus);

  // Full query like findPaginated + plugin
  const full = await db.collection('omni_conversations').countDocuments({
    $and: [
      { tenantId: '69ac2273e7e66e9799f6ffdd', status: { $in: ['open', 'pending'] } },
      { tenantId: '69ac2273e7e66e9799f6ffdd' }
    ]
  });
  console.log('Full query like plugin:', full);

  // Check the externalId field - maybe the schema uses externalId differently
  const sample = await db.collection('omni_conversations').findOne({ tenantId: '69ac2273e7e66e9799f6ffdd' });
  if (sample) {
    console.log('Sample fields:', Object.keys(sample));
    console.log('externalId:', sample.externalId);
    console.log('channelId:', sample.channelId);  
  }

  await c.close();
}

run().catch(console.error);
