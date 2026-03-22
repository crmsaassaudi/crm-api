const mongoose = require('mongoose');
const axios = require('axios');
const uri = 'mongodb+srv://nguyentoan102002_db_user:Xq0t6ZsieMIelTiz@crm.sfh1nlk.mongodb.net/crm?appName=crm';

async function run() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const channelId = '69be7d03e8bafc2813309293';
  
  const query = {
    $or: [
      { _id: channelId },
      { _id: new mongoose.Types.ObjectId(channelId) }
    ]
  };
  const chan = await db.collection('channels').findOne(query);
  if (!chan) {
    console.log('CHAN_NOT_FOUND_IN_DB');
    process.exit(0);
  }
  
  const token = chan.credentials?.accessToken;
  if (!token) {
    console.log('NO_TOKEN_IN_DB');
    process.exit(0);
  }
  
  console.log('--- FB TOKEN CHECK ---');
  console.log('Account ID in DB:', chan.account);
  console.log('Token Start:', token.substring(0, 10));

  try {
    const response = await axios.get('https://graph.facebook.com/v19.0/me', {
      params: { access_token: token, fields: 'id,name' }
    });
    console.log('TOKEN_IDENTITY_ME:', JSON.stringify(response.data));
  } catch (err) {
    console.log('DEBUG_ME_ERROR:', JSON.stringify(err.response?.data || err.message));
  }

  try {
    const pageId = chan.account;
    const response = await axios.get(`https://graph.facebook.com/v19.0/${pageId}`, {
      params: { access_token: token, fields: 'id,name' }
    });
    console.log('TOKEN_IDENTITY_PAGE:', JSON.stringify(response.data));
  } catch (err) {
    console.log('DEBUG_PAGE_ERROR:', JSON.stringify(err.response?.data || err.message));
  }
  
  process.exit(0);
}

run().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
