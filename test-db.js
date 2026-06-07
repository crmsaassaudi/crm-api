const { MongoClient } = require('mongodb');

async function main() {
  const uri = 'mongodb+srv://nguyentoan102002_db_user:Xq0t6ZsieMIelTiz@crm.sfh1nlk.mongodb.net/crm?appName=crm';
  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log('Connected to MongoDB');

    const db = client.db('crm');
    
    // Check tenants
    console.log('\n--- Tenants ---');
    const tenants = await db.collection('tenants').find({}).toArray();
    tenants.forEach(t => {
      console.log(`Tenant ID: ${t._id}, Name: ${t.name}, i18nSettings:`, JSON.stringify(t.i18nSettings));
    });

    // Check users
    console.log('\n--- Users ---');
    const users = await db.collection('users').find({}).toArray();
    users.forEach(u => {
      console.log(`User ID: ${u._id}, Email: ${u.email}, i18nPreferences:`, JSON.stringify(u.i18nPreferences));
    });

  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
}

main();
