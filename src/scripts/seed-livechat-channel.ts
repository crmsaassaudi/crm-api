import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import { randomBytes } from 'crypto';

/**
 * Onboarding script — creates a livechat Channel + Widget for local/dev testing
 * without needing a logged-in session to go through the admin HTTP API.
 *
 * Usage:
 *   npm run seed:livechat-channel -- --alias=master
 *   npm run seed:livechat-channel -- --alias=master --account=my-test-widget
 *
 * Idempotent: reruns reuse the existing channel/widget for the same
 * (tenant alias, account slug) instead of creating duplicates.
 */

interface Args {
  alias: string;
  account: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (key: string, fallback: string) => {
    const match = argv.find((a) => a.startsWith(`--${key}=`));
    return match ? match.slice(key.length + 3) : fallback;
  };
  return {
    alias: get('alias', 'master'),
    account: get('account', 'local-test-livechat'),
  };
}

async function findTenantId(
  db: import('mongodb').Db,
  alias: string,
): Promise<ObjectId> {
  const tenant = await db.collection('tenants').findOne({ alias });
  if (!tenant) {
    throw new Error(
      `Tenant with alias "${alias}" not found. Run init:master-org first, or pass --alias=<existing tenant alias>.`,
    );
  }
  return tenant._id as ObjectId;
}

async function upsertChannel(
  db: import('mongodb').Db,
  tenantId: ObjectId,
  account: string,
): Promise<ObjectId> {
  const existing = await db
    .collection('channels')
    .findOne({ tenantId, type: 'livechat', account });
  if (existing) {
    console.log(`  ↳ reusing existing channel ${existing._id.toString()}`);
    return existing._id as ObjectId;
  }

  const now = new Date();
  const res = await db.collection('channels').insertOne({
    tenantId,
    type: 'livechat',
    name: `Local Test Livechat (${account})`,
    account,
    status: 'Connected',
    config: {},
    createdAt: now,
    updatedAt: now,
  });
  console.log(`  ↳ created channel ${res.insertedId.toString()}`);
  return res.insertedId;
}

function buildDefaultWidgetSettings(name: string, widgetId: string) {
  return {
    widgetId,
    name,
    status: 'active',
    branding: { companyName: 'CRM Local Test' },
    theme: { primaryColor: '#6366f1' },
    layout: {
      position: 'bottom-right',
      launcherSize: 'medium',
      offsetX: 20,
      offsetY: 20,
    },
    welcome: { greeting: 'Hi there! (local test)' },
    launcher: { showUnreadBadge: true, pulseAnimation: false },
    mobile: { enabled: true, fullscreen: false, launcherBottomOffset: 16 },
    conversationStarters: [],
    offline: {},
    preChatForm: { trigger: 'before_chat', skipIfKnownVisitor: false },
    routing: {},
    automation: {},
    proactiveChat: { enabled: false, rules: [] },
    displayRules: {},
    csat: { enabled: false },
    security: { allowedDomains: [] },
    localization: { locale: 'en', autoDetect: true, fallbackLocale: 'en' },
    advanced: {
      enableSoundNotification: true,
      enableFileUpload: true,
      maxFileSize: 25,
      imagePreview: true,
      dragDrop: false,
      cameraCapture: false,
      maxFilesPerMessage: 1,
    },
    notifications: { sound: true, vibration: false },
    statePersistence: {
      rememberOpenState: false,
      rememberDraftMessage: true,
    },
  };
}

async function upsertWidget(
  db: import('mongodb').Db,
  tenantId: ObjectId,
  channelId: ObjectId,
  name: string,
): Promise<string> {
  const existing = await db
    .collection('livechat_widgets')
    .findOne({
      tenantId: tenantId.toString(),
      channelId: channelId.toString(),
      name,
    });
  if (existing) {
    console.log(`  ↳ reusing existing widget ${existing.widgetId}`);
    return existing.widgetId;
  }

  const widgetId = `wdg_${randomBytes(8).toString('hex')}`;
  const now = new Date();
  await db.collection('livechat_widgets').insertOne({
    tenantId: tenantId.toString(),
    channelId: channelId.toString(),
    ...buildDefaultWidgetSettings(name, widgetId),
    createdAt: now,
    updatedAt: now,
  });
  console.log(`  ↳ created widget ${widgetId}`);
  return widgetId;
}

async function seedLivechatChannel() {
  const { alias, account } = parseArgs();
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log('✅ Connected to MongoDB\n');

    const db = client.db();
    const tenantId = await findTenantId(db, alias);
    console.log(`Tenant "${alias}" → ${tenantId.toString()}`);

    const channelId = await upsertChannel(db, tenantId, account);
    const widgetId = await upsertWidget(
      db,
      tenantId,
      channelId,
      `Local Test Widget (${account})`,
    );

    console.log('\n=== Livechat channel ready ===');
    console.log(`  tenantId:  ${tenantId.toString()}`);
    console.log(`  channelId: ${channelId.toString()}`);
    console.log(`  widgetId:  ${widgetId}`);
    console.log(
      `\nPublic config: GET ${process.env.BACKEND_DOMAIN ?? 'http://localhost:3000'}/api/v1/livechat/config/${widgetId}`,
    );
    console.log(
      `Embed in livechat-widget/real.html: window.CRMWidget = { widgetId: '${widgetId}', apiUrl: 'http://localhost:3000' };`,
    );
  } catch (error) {
    console.error(
      'Seeding failed:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  } finally {
    await client.close();
  }
}

seedLivechatChannel().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
