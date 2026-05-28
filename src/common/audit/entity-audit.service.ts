import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { getTenantId, getUserId } from '../cls/cls-context.helper';

export type AuditEventKind = 'created' | 'updated' | 'deleted' | 'restored';

export interface EmitEntityAuditInput<T = any> {
  /** Lowercase entity name used as event prefix: contact, deal, ticket, task. */
  entity: string;
  /** Uppercase entity type matched by AuditLogListener: CONTACT, DEAL, ... */
  entityType: string;
  entityId: string;
  kind: AuditEventKind;
  oldSnapshot?: T;
  newSnapshot?: T;
  /** Optional override for source field — defaults to CLS executionSource. */
  src?: string;
}

/**
 * Shared emitter for entity audit events.
 *
 * Emits in the legacy shape consumed by `AuditLogListener.handleEntityUpdated`
 * (event = `<entity>.<kind>`, payload = `{ t, tenantId, entityType, entityId,
 * oldSnapshot, newSnapshot, actorId, src, ctx, ip, ua }`). This lets us
 * collapse the duplicate boilerplate sprinkled across contacts/deals/tickets/
 * tasks services into one call site without changing downstream consumers.
 */
@Injectable()
export class EntityAuditService {
  constructor(
    private readonly events: EventEmitter2,
    private readonly cls: ClsService,
  ) {}

  emit(input: EmitEntityAuditInput): void {
    const occurredAt = new Date();
    const payload = {
      t: occurredAt,
      tenantId: getTenantId(this.cls),
      entityType: input.entityType,
      entityId: input.entityId,
      // Snapshots are passed through as-is — listener can compare them.
      // We deep-clone here so later mutations in the caller don't leak.
      oldSnapshot: clone(input.oldSnapshot),
      newSnapshot: clone(input.newSnapshot),
      actorId: getUserId(this.cls),
      src: input.src ?? this.cls.get<string>('executionSource') ?? 'M',
      ctx: this.cls.get<unknown>('sourceContext'),
      ip: this.cls.get<string>('requestIp'),
      ua: this.cls.get<string>('userAgent'),
    };

    this.events.emit(`${input.entity}.${input.kind}`, payload);
  }
}

function clone<T>(value: T | undefined): T | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}
