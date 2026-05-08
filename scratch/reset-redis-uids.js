const Redis = require('ioredis');

async function resetImapUids() {
  const redis = new Redis({
    host: 'localhost',
    port: 6379,
    db: 0
  });

  try {
    const keys = await redis.keys('imap:lastuid:*');
    console.log(`Found ${keys.length} keys to delete:`, keys);

    if (keys.length > 0) {
      await redis.del(...keys);
      console.log('Successfully deleted all IMAP UID tracking keys.');
    } else {
      console.log('No IMAP UID tracking keys found.');
    }
  } catch (err) {
    console.error('Error deleting Redis keys:', err);
  } finally {
    redis.disconnect();
  }
}

resetImapUids();
