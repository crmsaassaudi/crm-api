const mongoose = require('mongoose');
const uri = 'mongodb+srv://nguyentoan102002_db_user:Xq0t6ZsieMIelTiz@crm.sfh1nlk.mongodb.net/crm?appName=crm';

async function run() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const targetId = '69be7f7a51025e2d5437151b';
  
  const query = {
    $or: [
      { _id: targetId },
      { _id: new mongoose.Types.ObjectId(targetId) }
    ]
  };
  
  const conv = await db.collection('omni_conversations').findOne(query);
  if (!conv) {
    console.log('CONV_NOT_FOUND_IN_DB');
    process.exit(0);
  }
  
  const chanId = conv.channel;
  let chanQuery = { _id: chanId };
  if (typeof chanId === 'string' && chanId.length === 24) {
    chanQuery = { $or: [ { _id: chanId }, { _id: new mongoose.Types.ObjectId(chanId) } ] };
  }
  
  const chan = await db.collection('channels').findOne(chanQuery);
  const hasToken = chan?.credentials?.accessToken;
  const tokenFirstChars = hasToken ? hasToken.substring(0, 10) + '...' : 'NONE';

  console.log('DATA_CHECK:', JSON.stringify({
    conv: { 
      id: conv._id, 
      channelId: conv.channel,
      customer_external: conv.customer?.externalId 
    },
    chan: { 
      id: chan?._id, 
      type: chan?.type, 
      account: chan?.account, 
      has_token: !!hasToken,
      token_start: tokenFirstChars
    }
  }, null , 2));
  
  process.exit(0);
}

run().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
