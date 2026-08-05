import { ExecutionPrincipal } from '../domain/execution-principal';
import { AutomationCrmModule } from '../events/automation-event.payload';

/**
 * Queue constants for the Automation Engine.
 *
 * Actions are split by transport (email / sms / internal / webhook) so a slow or
 * throttled channel cannot block the others, plus a DLQ, a low-priority bulk
 * queue, trigger evaluation and wait-node resumes.
 */

// Per-Type Action Queues (separated for independent rate limiting)
export const AUTOMATION_EMAIL_QUEUE = 'automation-actions-email';
export const AUTOMATION_SMS_QUEUE = 'automation-actions-sms';
export const AUTOMATION_INTERNAL_QUEUE = 'automation-actions-internal';
export const AUTOMATION_WEBHOOK_QUEUE = 'automation-actions-webhook';

// System Queues
export const AUTOMATION_ACTION_DLQ = 'automation-actions-dlq';
export const AUTOMATION_BULK_QUEUE = 'automation-actions-bulk';

/**
 * Trigger-evaluation queue.
 *
 * Trigger matching and DAG traversal used to run inline, un-awaited, on the
 * emitting process — so a `PATCH /contacts/:id` paid for the workflow lookup,
 * the loop-prevention Redis round-trips, the condition evaluation and the
 * execution-log writes of every matching workflow on its own event loop, after
 * the response had gone out.
 */
export const AUTOMATION_TRIGGER_QUEUE = 'automation-triggers';
export const AUTOMATION_DELAYED_QUEUE = 'automation-delayed-resume';

/**
 * Every action type the engine can execute.
 *
 * Single source of truth: the workflow service validates saves against it, the
 * action processor validates jobs against it, and the web builder imports the
 * same list through `GET /automation-workflows/capabilities`. Three hand-kept
 * copies had already drifted — the builder still offered two actions the API
 * refused at save time.
 */
export const AUTOMATION_ACTION_TYPES = [
  'send_email',
  'send_sms',
  'send_livechat',
  'internal_notification',
  'update_field',
  'route_to_group',
  'create_task',
  'create_ticket',
  'create_record',
  'add_tag',
  'remove_tag',
  'add_note',
  'webhook',
  'http_request',
] as const;

export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

export const AUTOMATION_ACTION_TYPE_SET: ReadonlySet<string> = new Set(
  AUTOMATION_ACTION_TYPES,
);

/**
 * Job names used within the automation action queues.
 * Each action type has a distinct name for observability in BullMQ dashboards.
 */
export enum AutomationJobName {
  SEND_EMAIL = 'automation.send-email',
  SEND_SMS = 'automation.send-sms',
  SEND_LIVECHAT = 'automation.send-livechat',
  INTERNAL_NOTIFICATION = 'automation.internal-notification',
  UPDATE_FIELD = 'automation.update-field',
  ROUTE_TO_TEAM = 'automation.route-to-team',
  CREATE_TASK = 'automation.create-task',
  CREATE_TICKET = 'automation.create-ticket',
  CREATE_RECORD = 'automation.create-record',
  ADD_TAG = 'automation.add-tag',
  REMOVE_TAG = 'automation.remove-tag',
  ADD_NOTE = 'automation.add-note',
  WEBHOOK = 'automation.webhook',
  HTTP_REQUEST = 'automation.http-request',
  DELAYED_RESUME = 'automation.delayed-resume',
}

const JOB_NAME_BY_ACTION: Record<AutomationActionType, AutomationJobName> = {
  send_email: AutomationJobName.SEND_EMAIL,
  send_sms: AutomationJobName.SEND_SMS,
  send_livechat: AutomationJobName.SEND_LIVECHAT,
  internal_notification: AutomationJobName.INTERNAL_NOTIFICATION,
  update_field: AutomationJobName.UPDATE_FIELD,
  route_to_group: AutomationJobName.ROUTE_TO_TEAM,
  create_task: AutomationJobName.CREATE_TASK,
  create_ticket: AutomationJobName.CREATE_TICKET,
  create_record: AutomationJobName.CREATE_RECORD,
  add_tag: AutomationJobName.ADD_TAG,
  remove_tag: AutomationJobName.REMOVE_TAG,
  add_note: AutomationJobName.ADD_NOTE,
  webhook: AutomationJobName.WEBHOOK,
  http_request: AutomationJobName.HTTP_REQUEST,
};

const QUEUE_BY_ACTION: Record<AutomationActionType, string> = {
  send_email: AUTOMATION_EMAIL_QUEUE,
  send_sms: AUTOMATION_SMS_QUEUE,
  send_livechat: AUTOMATION_SMS_QUEUE,
  internal_notification: AUTOMATION_INTERNAL_QUEUE,
  update_field: AUTOMATION_INTERNAL_QUEUE,
  route_to_group: AUTOMATION_INTERNAL_QUEUE,
  create_task: AUTOMATION_INTERNAL_QUEUE,
  create_ticket: AUTOMATION_INTERNAL_QUEUE,
  create_record: AUTOMATION_INTERNAL_QUEUE,
  add_tag: AUTOMATION_INTERNAL_QUEUE,
  remove_tag: AUTOMATION_INTERNAL_QUEUE,
  add_note: AUTOMATION_INTERNAL_QUEUE,
  webhook: AUTOMATION_WEBHOOK_QUEUE,
  http_request: AUTOMATION_WEBHOOK_QUEUE,
};

/**
 * actionType → BullMQ job name. Throws on an unknown type rather than
 * defaulting: a default mislabels the job and hides the typo that caused it.
 */
export function resolveJobNameForAction(actionType: string): AutomationJobName {
  const jobName = JOB_NAME_BY_ACTION[actionType as AutomationActionType];
  if (!jobName) {
    throw new Error(`Unknown automation actionType "${actionType}"`);
  }
  return jobName;
}

/** actionType → which typed queue to dispatch to. Throws on unknown types. */
export function resolveQueueForAction(actionType: string): string {
  const queue = QUEUE_BY_ACTION[actionType as AutomationActionType];
  if (!queue) {
    throw new Error(`Unknown automation actionType "${actionType}"`);
  }
  return queue;
}

/**
 * One CRM event awaiting trigger evaluation.
 *
 * Carries the event, not a workflow: which workflows match is decided by the
 * worker, against the state of the world when it runs.
 */
export interface AutomationTriggerJobData {
  eventId?: string;
  tenantId: string;
  event: 'record_created' | 'field_updated';
  object: string;
  recordId: string;
  data: Record<string, any>;
  changedFields?: string[];
  automationDepth?: number;
  automationBreadcrumbs?: string[];
  _automationSourceWorkflowId?: string;
  triggerUserId?: string | null;
}

/**
 * Payload dispatched to the low-priority bulk queue when a tenant exceeds the
 * event-rate threshold.
 *
 * `tenantId` is at the TOP LEVEL deliberately: BaseTenantConsumer reads it from
 * `job.data.tenantId` to establish CLS before `handle()` runs and throws when it
 * is absent.
 *
 * `workflowId` is carried instead of the whole workflow document so the
 * processor re-reads the current published snapshot rather than executing a
 * definition that has been sitting in Redis.
 */
export interface AutomationBulkJobData {
  tenantId: string;
  workflowId: string;
  payload: {
    tenantId: string;
    event: string;
    object: string;
    recordId: string;
    [key: string]: any;
  };
}

/**
 * The published graph an in-flight execution is bound to.
 *
 * `publish()` overwrites `publishedNodes` in place, so anything that leaves the
 * orchestrator and comes back — an action job, a delayed resume — has to carry
 * the graph it started on. Otherwise a workflow edited mid-execution resumes
 * into a different graph at a node id that may mean something else or no longer
 * exist, which defeats the point of publishing a snapshot at all.
 */
export interface PinnedGraph {
  workflowVersion: number | null;
  publishedNodes: any[];
  publishedEdges: any[];
}

/**
 * Payload dispatched to the automation action queues.
 */
export interface AutomationActionJobData extends PinnedGraph {
  /** The execution log ID for this workflow run */
  executionId: string;

  /** The workflow that dispatched this action */
  workflowId: string;

  /** Tenant context */
  tenantId: string;

  /** The node that defines this action */
  nodeId: string;
  nodeName: string;

  /** The action type — maps to a specific executor */
  actionType: AutomationActionType;

  /** Action-specific config set by the admin in the Visual Builder */
  actionConfig: Record<string, any>;

  /** Who this action executes as. */
  principal: ExecutionPrincipal;

  /** The record that triggered the workflow */
  recordId: string;
  recordType: AutomationCrmModule;
  recordData: Record<string, any>;

  /** Automation depth for loop prevention Layer 2 */
  automationDepth: number;

  /** Workflow IDs already visited in this automation chain */
  automationBreadcrumbs?: string[];

  /** Source workflow ID for self-loop prevention */
  sourceWorkflowId: string;

  /**
   * Session ID for strict loop prevention Layer 1.
   *
   * Carried so the traversal that continues after this action shares the
   * originating execution's loop-guard window instead of starting a fresh one.
   */
  executionSessionId: string;
}

/**
 * Payload for the delayed resume queue.
 * The record is deliberately NOT carried — it is re-read on resume so a wait
 * node sees the record as it is when the delay expires, not as it was.
 */
export interface AutomationDelayedJobData extends PinnedGraph {
  /** Execution log ID — this execution is still "running" / "waiting" */
  executionId: string;

  /** Workflow ID (for logging and tenant-scoped lookups) */
  workflowId: string;

  /** Tenant context */
  tenantId: string;

  /** The node ID to resume FROM (downstream of the wait node) */
  resumeFromNodeId: string;

  /** Record identifiers for re-fetch. */
  recordId: string;
  recordType: AutomationCrmModule;

  /** Automation depth for loop prevention Layer 2 */
  automationDepth: number;

  /** Workflow IDs already visited in this automation chain */
  automationBreadcrumbs?: string[];

  /** Source workflow ID for self-loop prevention */
  sourceWorkflowId: string;

  /** Session ID for strict loop prevention Layer 1 */
  executionSessionId: string;

  /** Principal the resumed actions execute as. See ExecutionPrincipal. */
  principal: ExecutionPrincipal;
}

/** Hot Redis queue payload for a due delayed job held in Mongo cold storage. */
export interface AutomationDelayedQueueJobData
  extends AutomationDelayedJobData {
  delayedJobId: string;
}
