import 'dotenv/config';
import mongoose from 'mongoose';

type ExpectedIndex = {
  collection: string;
  name: string;
  key: Record<string, 1 | -1>;
  unique?: boolean;
  expireAfterSeconds?: number;
};

const expectedIndexes: ExpectedIndex[] = [
  {
    collection: 'omni_messages',
    name: 'dedup_external_message',
    key: { tenantId: 1, externalMessageId: 1 },
    unique: true,
  },
  {
    collection: 'omni_messages',
    name: 'dedup_platform_message',
    key: { tenantId: 1, platformMessageId: 1 },
    unique: true,
  },
  {
    collection: 'users',
    name: 'users_tenant_member_lookup',
    key: { 'tenants.tenantId': 1, _id: 1 },
  },
  {
    collection: 'users',
    name: 'users_keycloak_provider',
    key: { keycloakId: 1, provider: 1 },
  },
  {
    collection: 'groups',
    name: 'groups_member_lookup',
    key: { tenantId: 1, memberIds: 1 },
  },
  {
    collection: 'automation_execution_logs',
    name: 'automation_logs_workflow_status_started',
    key: { tenantId: 1, workflowId: 1, status: 1, startedAt: -1 },
  },
  {
    collection: 'automation_execution_logs',
    name: 'expireAt_1',
    key: { expireAt: 1 },
    expireAfterSeconds: 0,
  },
];

async function main() {
  const uri = buildMongoUri();
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('MongoDB connection did not expose a database handle');
  }

  const failures: string[] = [];
  for (const expected of expectedIndexes) {
    const indexes = await db.collection(expected.collection).indexes();
    const actual = indexes.find((index) => index.name === expected.name);

    if (!actual) {
      failures.push(`${expected.collection}: missing index ${expected.name}`);
      continue;
    }

    if (JSON.stringify(actual.key) !== JSON.stringify(expected.key)) {
      failures.push(
        `${expected.collection}.${expected.name}: key mismatch expected=${JSON.stringify(
          expected.key,
        )} actual=${JSON.stringify(actual.key)}`,
      );
    }

    if (
      expected.unique !== undefined &&
      Boolean(actual.unique) !== expected.unique
    ) {
      failures.push(
        `${expected.collection}.${expected.name}: unique mismatch expected=${expected.unique}`,
      );
    }

    if (
      expected.expireAfterSeconds !== undefined &&
      actual.expireAfterSeconds !== expected.expireAfterSeconds
    ) {
      failures.push(
        `${expected.collection}.${expected.name}: expireAfterSeconds mismatch expected=${expected.expireAfterSeconds}`,
      );
    }
  }

  await mongoose.disconnect();

  if (failures.length > 0) {
    console.error(
      ['Operational index verification failed:', ...failures].join('\n'),
    );
    process.exit(1);
  }

  console.log('Operational index verification passed.');
}

function buildMongoUri(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const host = process.env.DATABASE_HOST ?? 'localhost';
  const port = process.env.DATABASE_PORT ?? '27017';
  const name = process.env.DATABASE_NAME ?? 'crm';
  const username = process.env.DATABASE_USERNAME;
  const password = process.env.DATABASE_PASSWORD;
  const auth =
    username && password
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : '';

  return `mongodb://${auth}${host}:${port}/${name}`;
}

void main().catch(async (error) => {
  await mongoose.disconnect().catch(() => undefined);
  console.error(error);
  process.exit(1);
});
