import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ContactsService } from '../../contacts/contacts.service';
import { TicketsService } from '../../tickets/tickets.service';
import { DealsService } from '../../deals/deals.service';
import { AccountsService } from '../../accounts/accounts.service';
import { TasksService } from '../../tasks/tasks.service';
import {
  AutomationCrmModule,
  AutomationEventPayload,
  buildAutomationEventName,
} from '../events/automation-event.payload';

/**
 * CrmRecordUpdateService — unified record update for automation actions.
 *
 * Provides a single entry point for UpdateFieldExecutor and RouteToGroupExecutor
 * to update any CRM record. Handles:
 *   - Module resolution (Contact/Ticket/Deal/Account/Task)
 *   - Type casting (String → Number/Boolean/Date) to avoid schema errors
 *   - Self-loop prevention: attaches _automationSourceWorkflowId to emitted events
 *   - Re-emitting field_updated events with incremented automationDepth
 */
@Injectable()
export class CrmRecordUpdateService {
  private readonly logger = new Logger(CrmRecordUpdateService.name);

  /**
   * System / identity / audit fields that NO automation action may ever write
   * (MED-01). Setting these could escalate tenant scope, corrupt identity,
   * or rewrite audit trails.
   */
  private static readonly PROTECTED_FIELDS = new Set<string>([
    '_id',
    'id',
    'tenantId',
    'createdAt',
    'updatedAt',
    'createdBy',
    '__v',
  ]);

  /**
   * Ownership fields that only privileged internal executors (e.g.
   * RouteToGroupExecutor) may write. External `update_field` actions are
   * blocked unless the caller explicitly opts in via `allowRestricted`.
   */
  private static readonly RESTRICTED_FIELDS = new Set<string>(['ownerId']);

  /**
   * Fields no automation may set when CREATING a record.
   *
   * The update path has had a denylist since MED-01, but `create_record` fed
   * an unvalidated field map straight into `service.create()`, so everything
   * the update path refused could be set at birth instead — including
   * `ownerId` (an ownership grant that skips the assignment engine entirely)
   * and `orgUnitId` (which decides who can see the record).
   *
   * Superset of PROTECTED_FIELDS + RESTRICTED_FIELDS, plus the `*ById`
   * variants the repositories actually persist and the org-unit axis.
   */
  private static readonly CREATE_DENIED_FIELDS = new Set<string>([
    '_id',
    'id',
    'tenantId',
    'createdAt',
    'updatedAt',
    'createdBy',
    'createdById',
    'updatedBy',
    'updatedById',
    '__v',
    'ownerId',
    'orgUnitId',
  ]);

  /**
   * Reject a create payload that touches identity, tenancy, audit or ownership
   * fields. Returns the offending keys; an empty array means the payload is
   * safe to hand to a `create()`.
   *
   * Deliberately a hard rejection rather than a silent strip: an author who
   * mapped `ownerId` needs to see that it did not happen, and see it in the
   * execution log, instead of quietly getting an unowned record.
   */
  static findDeniedCreateFields(data: Record<string, unknown>): string[] {
    return Object.keys(data).filter((key) =>
      // Dot-paths are checked on their root so `ownerId.foo` cannot slip past.
      CrmRecordUpdateService.CREATE_DENIED_FIELDS.has(key.split('.')[0]),
    );
  }

  constructor(
    private readonly contactsService: ContactsService,
    private readonly ticketsService: TicketsService,
    private readonly dealsService: DealsService,
    private readonly accountsService: AccountsService,
    private readonly tasksService: TasksService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Update a single field on a CRM record.
   *
   * @param params.tenantId - Tenant context
   * @param params.recordType - CRM module (Contact, Ticket, etc.)
   * @param params.recordId - MongoDB _id of the record
   * @param params.field - Field name to update
   * @param params.value - New value (will be type-cast)
   * @param params.sourceWorkflowId - Workflow that triggered this update (for loop prevention)
   * @param params.automationDepth - Current chain depth (incremented for cascading triggers)
   */
  async updateField(params: {
    tenantId: string;
    recordType: AutomationCrmModule;
    recordId: string;
    field: string;
    value: any;
    sourceWorkflowId: string;
    automationDepth?: number;
    automationBreadcrumbs?: string[];
    /** When true, allows writing RESTRICTED_FIELDS (e.g. ownerId). Internal use only. */
    allowRestricted?: boolean;
    /**
     * Optimistic-concurrency guard: the write is refused (not attempted) unless
     * the record's current value for `field` still equals this. Used by
     * route_to_group so a retried automation job — the write already landed,
     * the job crashed before ack, BullMQ redelivers it — sees the field has
     * moved and reports a lost race instead of assigning a second time.
     */
    expectedPreviousValue?: any;
  }): Promise<{
    success: boolean;
    previousValue: any;
    newValue: any;
    error?: string;
    /** True when the write was refused because `expectedPreviousValue` no longer matched. */
    raceLost?: boolean;
  }> {
    const { tenantId, recordType, recordId, field, sourceWorkflowId } = params;

    this.logger.log(
      `[CrmUpdate] ${recordType}(${recordId}).${field} = "${params.value}" | tenant=${tenantId}`,
    );

    // Two-tier field protection.
    // Tier 1 (PROTECTED): system/identity fields — NEVER writable by automation.
    // Tier 2 (RESTRICTED): ownership fields — writable only by privileged
    //   internal executors (e.g. RouteToGroupExecutor) via allowRestricted flag.
    if (CrmRecordUpdateService.PROTECTED_FIELDS.has(field)) {
      this.logger.warn(
        `[CrmUpdate] Blocked attempt to set protected field "${field}" on ${recordType}(${recordId})`,
      );
      return {
        success: false,
        previousValue: undefined,
        newValue: params.value,
        error: `Field "${field}" is protected and cannot be set by automation`,
      };
    }

    if (
      CrmRecordUpdateService.RESTRICTED_FIELDS.has(field) &&
      !params.allowRestricted
    ) {
      this.logger.warn(
        `[CrmUpdate] Blocked attempt to set restricted field "${field}" on ${recordType}(${recordId}) (allowRestricted=false)`,
      );
      return {
        success: false,
        previousValue: undefined,
        newValue: params.value,
        error: `Field "${field}" is restricted. Use a dedicated action (e.g. Route to Team) instead of update_field.`,
      };
    }

    try {
      const service = this.getServiceForModule(recordType);
      if (!service) {
        return {
          success: false,
          previousValue: undefined,
          newValue: params.value,
          error: `Unsupported module: ${recordType}`,
        };
      }

      const currentRecord = await service.findOne(recordId);
      if (!currentRecord) {
        return {
          success: false,
          previousValue: undefined,
          newValue: params.value,
          error: `Record not found: ${recordType}(${recordId})`,
        };
      }

      const previousValue = currentRecord[field];

      // Optimistic-concurrency guard
      if ('expectedPreviousValue' in params) {
        const normalize = (v: any) =>
          v === undefined || v === null ? null : String(v);
        if (
          normalize(previousValue) !== normalize(params.expectedPreviousValue)
        ) {
          this.logger.warn(
            `[CrmUpdate] Lost race writing "${field}" on ${recordType}(${recordId}): expected ${normalize(params.expectedPreviousValue)}, found ${normalize(previousValue)}`,
          );
          return {
            success: false,
            previousValue,
            newValue: params.value,
            error: `Field "${field}" changed since the decision was made — write refused`,
            raceLost: true,
          };
        }
      }

      const castedValue = this.castValue(params.value, previousValue);

      const updateData = { [field]: castedValue } as any;
      const updated = await service.update(recordId, updateData);

      if (!updated) {
        return {
          success: false,
          previousValue,
          newValue: castedValue,
          error: `Update returned null for ${recordType}(${recordId})`,
        };
      }

      // The EventListener will skip workflows whose _id matches sourceWorkflowId
      await this.emitFieldUpdatedEvent({
        tenantId,
        recordType,
        recordId,
        record: updated,
        changedFields: [field],
        sourceWorkflowId,
        automationDepth: (params.automationDepth ?? 0) + 1,
        automationBreadcrumbs: params.automationBreadcrumbs,
      });

      this.logger.log(
        `[CrmUpdate] ✅ ${recordType}(${recordId}).${field}: "${previousValue}" → "${castedValue}"`,
      );

      return {
        success: true,
        previousValue,
        newValue: castedValue,
      };
    } catch (error: any) {
      this.logger.error(
        `[CrmUpdate] ❌ Failed to update ${recordType}(${recordId}).${field}: ${error.message}`,
        error.stack,
      );
      return {
        success: false,
        previousValue: undefined,
        newValue: params.value,
        error: error.message,
      };
    }
  }

  /**
   * Fetch a fresh record from the database.
   * Used by the delayed queue processor to re-fetch data after a wait node.
   *
   * @returns Full record data, or null if record was deleted
   */
  async fetchRecord(
    recordType: AutomationCrmModule,
    recordId: string,
  ): Promise<Record<string, any> | null> {
    const service = this.getServiceForModule(recordType);
    if (!service) return null;

    const record = await service.findOne(recordId);
    return record ?? null;
  }

  // Private Helpers

  /**
   * Resolve the CRM service for a given module type.
   * Lead is handled by ContactsService (Contacts with lifecycle stages).
   */
  private getServiceForModule(recordType: AutomationCrmModule): {
    findOne: (id: string) => Promise<any>;
    update: (id: string, data: any) => Promise<any>;
  } | null {
    switch (recordType) {
      case 'Lead':
      case 'Contact':
        return this.contactsService;
      case 'Ticket':
        return this.ticketsService;
      case 'Deal':
        return this.dealsService;
      case 'Account':
        return this.accountsService;
      case 'Task':
        return this.tasksService;
      default:
        return null;
    }
  }

  /**
   * Type casting engine — cast string values from the automation config
   * to the appropriate type based on the current field value type.
   *
   * Rules:
   *   "true"/"false" → Boolean
   *   Numeric string  → Number (via parseFloat, with isNaN check)
   *   ISO date string → Date
   *   Fallback        → String (no change)
   */
  private castValue(newValue: any, currentValue: any): any {
    if (newValue === undefined || newValue === null) return newValue;

    const strValue = String(newValue).trim();

    if (typeof currentValue === 'boolean') {
      return strValue.toLowerCase() === 'true';
    }

    if (typeof currentValue === 'number') {
      const num = parseFloat(strValue);
      if (!isNaN(num)) return num;
    }

    if (currentValue instanceof Date) {
      const date = new Date(strValue);
      if (!isNaN(date.getTime())) return date;
    }

    // Explicit Boolean strings (when current value type is unknown)
    if (strValue.toLowerCase() === 'true') return true;
    if (strValue.toLowerCase() === 'false') return false;

    // Explicit Number (when string looks like a number but current type is unknown)
    // Only cast if the string is purely numeric to avoid false positives
    if (/^-?\d+(\.\d+)?$/.test(strValue)) {
      return parseFloat(strValue);
    }

    if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/.test(strValue)) {
      const date = new Date(strValue);
      if (!isNaN(date.getTime())) return date;
    }

    return strValue;
  }

  /**
   * Emit a field_updated automation event with loop prevention metadata.
   * Uses fire-and-forget pattern — errors in downstream automation
   * don't affect this update.
   */
  private emitFieldUpdatedEvent(params: {
    tenantId: string;
    recordType: AutomationCrmModule;
    recordId: string;
    record: Record<string, any>;
    changedFields: string[];
    sourceWorkflowId: string;
    automationDepth: number;
    automationBreadcrumbs?: string[];
  }): Promise<void> {
    const payload: AutomationEventPayload = {
      tenantId: params.tenantId,
      event: 'field_updated',
      object: params.recordType,
      recordId: params.recordId,
      data: params.record,
      changedFields: params.changedFields,
      automationDepth: params.automationDepth,
      automationBreadcrumbs: params.automationBreadcrumbs,
      _automationSourceWorkflowId: params.sourceWorkflowId,
    };

    return this.eventEmitter
      .emitAsync(
        buildAutomationEventName('field_updated', params.recordType),
        payload,
      )
      .then(() => undefined);
  }
}
