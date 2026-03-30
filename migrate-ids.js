const mongoose = require('mongoose');

const url = 'mongodb+srv://nguyentoan102002_db_user:Xq0t6ZsieMIelTiz@crm.sfh1nlk.mongodb.net/crm?appName=crm';

async function main() {
  await mongoose.connect(url);
  console.log('Connected to MongoDB via Mongoose');
  const db = mongoose.connection.db;

  try {
    // 5. Fix Users (Array elements)
    const users = await db.collection('users').find({ "tenants.tenant": { $exists: true } }).toArray();
    let updatedUsersCount = 0;
    for (const u of users) {
      const newTenants = u.tenants.map(t => {
        if (t.tenant) {
          t.tenantId = t.tenant;
          delete t.tenant;
        }
        return t;
      });
      await db.collection('users').updateOne({ _id: u._id }, { $set: { tenants: newTenants } });
      updatedUsersCount++;
    }
    console.log(`Updated ${updatedUsersCount} users.`);

    // 6. Fix Omni Conversation Activities
    let res = await db.collection('omni_conversation_activities').updateMany(
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
    await mongoose.disconnect();
    console.log('Migration complete. You can now delete this script.');
  }
}

main().catch(console.error);
