/**
 * Payload emitted by CRM Services (contacts, deals, tickets) when an entity
 * is updated. Consumed by AuditLogListener for diff computation and enqueuing.
 *
 * [PATCH P1] `t` is generated at the CRM Service layer (request thread time).
 * [PATCH P2] `oldSnapshot` / `newSnapshot` are plain objects — diff runs at
 *            the Listener, NOT the Worker.
 */
export interface AuditEntityUpdatedEvent {
  /** [PATCH P1] Timestamp of the actual request, NOT worker processing time */
  t: Date;
  tenantId: string;
  entityType: 'CONTACT' | 'DEAL' | 'TICKET';
  entityId: string;
  /** MongoDB ObjectId of the user/actor performing the change */
  actorId?: string;
  /** Execution source: M=Manual, A=API, A_F=Automation, B=Bot, S=System */
  src: string;
  /** Source context: identifies the specific automation/bot/apikey */
  ctx?: { flowId?: string; keyId?: string; botId?: string };
  /** Client IP from CLS */
  ip?: string;
  /** User-Agent from CLS */
  ua?: string;
  /** Plain object snapshot BEFORE the update */
  oldSnapshot: Record<string, any>;
  /** Plain object snapshot AFTER the update */
  newSnapshot: Record<string, any>;
}

/**
 * Payload for the BullMQ 'audit-queue' job.
 * Contains pre-computed changes[] (NOT raw snapshots).
 * [PATCH P2] Keeps Redis payload < 500 bytes per job.
 */
export interface AuditQueueJobData {
  t: string; // ISO string (serialized Date)
  tenantId: string;
  entityType: string;
  entityId: string;
  actorId: string;
  src: string;
  ctx?: { flowId?: string; keyId?: string; botId?: string };
  ip?: string;
  ua?: string;
  /** Pre-computed field-level changes — NOT raw snapshots */
  changes: Array<{ f: string; l?: string; o: any; n: any }>;
}
