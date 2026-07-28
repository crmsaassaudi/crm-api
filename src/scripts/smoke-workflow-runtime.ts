import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import { ulid } from 'ulid';

const POLL_INTERVAL_MS = 250;
const TIMEOUT_MS = 20_000;

async function waitFor<T>(
  description: string,
  load: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await load();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');

  const client = new MongoClient(databaseUrl);
  const tenantId = new ObjectId();
  const workflowId = new ObjectId();
  const recordId = new ObjectId().toHexString();
  const eventId = ulid();
  const workflowName = `__workflow_smoke_${eventId}`;

  await client.connect();
  const db = client.db();
  try {
    const hello = await db.admin().command({ hello: 1 });
    if (!hello.setName || !hello.isWritablePrimary) {
      throw new Error('Workflow smoke test requires a writable replica set.');
    }

    const trigger = {
      event: 'record_created',
      object: 'Contact',
      runOncePerRecord: false,
    };
    const triggerNode = {
      id: `trigger-${eventId}`,
      type: 'trigger',
      position: { x: 0, y: 0 },
      config: {},
    };
    const now = new Date();

    await db.collection('automation_workflows').insertOne({
      _id: workflowId,
      tenantId,
      name: workflowName,
      description: 'Automated production-readiness smoke test',
      status: 'active',
      triggerConfig: trigger,
      nodes: [triggerNode],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      executionCount: 0,
      lastExecutedAt: null,
      runAs: 'system',
      createdBy: 'workflow-smoke-test',
      updatedBy: 'workflow-smoke-test',
      publishedNodes: [triggerNode],
      publishedEdges: [],
      publishedTriggerConfig: trigger,
      publishedAt: now,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    await db.collection('automation_outbox_events').insertOne({
      tenantId,
      eventId,
      eventType: 'record_created.Contact',
      aggregateId: recordId,
      payload: {
        tenantId: tenantId.toHexString(),
        eventId,
        event: 'record_created',
        object: 'Contact',
        recordId,
        data: { id: recordId, smoke: true },
        automationDepth: 0,
        triggerUserId: null,
      },
      status: 'pending',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const outbox = await waitFor('outbox publication', async () => {
      const row = await db
        .collection('automation_outbox_events')
        .findOne({ eventId });
      return row?.status === 'published' ? row : null;
    });

    const execution = await waitFor(
      'successful workflow execution',
      async () => {
        const row = await db.collection('automation_execution_logs').findOne({
          tenantId,
          workflowId,
          recordId,
        });
        return row?.status === 'success' ? row : null;
      },
    );

    console.log(
      JSON.stringify({
        status: 'passed',
        replicaSet: hello.setName,
        eventId,
        outboxStatus: outbox.status,
        executionStatus: execution.status,
        workflowVersion: execution.workflowVersion,
      }),
    );
  } finally {
    await Promise.all([
      db.collection('automation_execution_logs').deleteMany({ tenantId }),
      db.collection('automation_outbox_events').deleteMany({ tenantId }),
      db.collection('automation_workflows').deleteMany({ tenantId }),
    ]);
    await client.close();
  }
}

void main().catch((error: Error) => {
  console.error(`[workflow-smoke] ${error.message}`);
  process.exitCode = 1;
});
