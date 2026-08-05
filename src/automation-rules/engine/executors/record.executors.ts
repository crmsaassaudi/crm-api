import { Injectable, Logger } from '@nestjs/common';
import { ActionExecutionResult, ActionExecutor } from './executor.interface';
import { AutomationActionJobData } from '../../queue/automation-queue.constants';
import { TemplateInterpolationService } from '../template-interpolation.service';
import { CrmRecordUpdateService } from '../crm-record-update.service';
import { NotesService } from '../../../notes/notes.service';
import { ContactsService } from '../../../contacts/contacts.service';
import { DealsService } from '../../../deals/deals.service';
import { AccountsService } from '../../../accounts/accounts.service';
import { TicketsService } from '../../../tickets/tickets.service';
import { TasksService } from '../../../tasks/tasks.service';

// Update Field

@Injectable()
export class UpdateFieldExecutor implements ActionExecutor {
  readonly actionType = 'update_field';
  private readonly logger = new Logger(UpdateFieldExecutor.name);

  constructor(private readonly crmUpdate: CrmRecordUpdateService) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordType, actionConfig, tenantId } = job;
    const field = actionConfig.targetField;
    const value = actionConfig.targetValue;

    if (!field) {
      return {
        success: false,
        retryable: false,
        error: { code: 'NO_FIELD', message: 'targetField is required' },
      };
    }

    this.logger.log(
      `[UpdateField] tenant=${tenantId} ${recordType}(${recordId}).${field} = "${value}"`,
    );

    const result = await this.crmUpdate.updateField({
      tenantId,
      recordType,
      recordId,
      field,
      value,
      sourceWorkflowId: job.sourceWorkflowId,
      automationDepth: job.automationDepth,
      automationBreadcrumbs: job.automationBreadcrumbs,
    });

    if (!result.success) {
      return {
        success: false,
        error: {
          code: 'UPDATE_FIELD_FAILED',
          message:
            result.error ??
            `Failed to update ${recordType}(${recordId}).${field}`,
        },
      };
    }

    return {
      success: true,
      output: {
        recordType,
        recordId,
        field,
        previousValue: result.previousValue,
        newValue: result.newValue,
      },
    };
  }
}

// Tags

/**
 * Shared read-merge-write for the tag actions.
 *
 * The record is re-read rather than trusted from the job payload: `recordData` is
 * serialised at dispatch time, so two concurrent tag writes on the same record
 * would each merge against a stale array and the second would drop the first.
 */
abstract class TagExecutor implements ActionExecutor {
  abstract readonly actionType: string;
  protected abstract readonly logger: Logger;

  constructor(protected readonly crmUpdate: CrmRecordUpdateService) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordType, actionConfig, tenantId } = job;

    const tags = parseTagList(actionConfig.tags);
    if (tags.length === 0) {
      return {
        success: false,
        retryable: false,
        error: { code: 'NO_TAGS', message: 'actionConfig.tags is required' },
      };
    }

    const freshRecord = await this.crmUpdate.fetchRecord(
      recordType as any,
      recordId,
    );
    if (!freshRecord) {
      return {
        success: false,
        retryable: false,
        error: {
          code: 'RECORD_NOT_FOUND',
          message: `${recordType}(${recordId}) no longer exists`,
        },
      };
    }
    const existing: string[] = Array.isArray(freshRecord.tags)
      ? freshRecord.tags
      : [];

    const next = this.merge(existing, tags);
    if (next === null) {
      this.logger.log(
        `[${this.actionType}] No-op on ${recordType}(${recordId}) — nothing to change`,
      );
      return { success: true, output: { changed: false, tags: existing } };
    }

    this.logger.log(
      `[${this.actionType}] tenant=${tenantId} ${recordType}(${recordId}) → [${next.join(', ')}]`,
    );

    const result = await this.crmUpdate.updateField({
      tenantId,
      recordType: recordType as any,
      recordId,
      field: 'tags',
      value: next,
      sourceWorkflowId: job.sourceWorkflowId,
      automationDepth: job.automationDepth,
      automationBreadcrumbs: job.automationBreadcrumbs,
    });

    if (!result.success) {
      return {
        success: false,
        error: {
          code: 'TAG_UPDATE_FAILED',
          message:
            result.error ??
            `Failed to update tags on ${recordType}(${recordId})`,
        },
      };
    }

    return { success: true, output: { changed: true, tags: next } };
  }

  /** @returns the new tag list, or null when nothing would change. */
  protected abstract merge(
    existing: string[],
    requested: string[],
  ): string[] | null;
}

function parseTagList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t) => typeof t === 'string');
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

@Injectable()
export class AddTagExecutor extends TagExecutor {
  readonly actionType = 'add_tag';
  protected readonly logger = new Logger(AddTagExecutor.name);

  protected merge(existing: string[], requested: string[]): string[] | null {
    const merged = Array.from(new Set([...existing, ...requested]));
    return merged.length === existing.length ? null : merged;
  }
}

@Injectable()
export class RemoveTagExecutor extends TagExecutor {
  readonly actionType = 'remove_tag';
  protected readonly logger = new Logger(RemoveTagExecutor.name);

  protected merge(existing: string[], requested: string[]): string[] | null {
    const remove = new Set(requested);
    const filtered = existing.filter((t) => !remove.has(t));
    return filtered.length === existing.length ? null : filtered;
  }
}

// Add Note

/**
 * Attach a note to the contact behind the triggering record.
 *
 * A record with no resolvable contact is now a failure. It used to emit
 * `automation.note-fallback` and return success — an event with no subscriber
 * anywhere in the repository, so a "log a note on every won deal" workflow
 * reported success and wrote nothing. Notes are only attachable to contacts, so
 * the honest answer is to say the action cannot run on this record.
 */
@Injectable()
export class AddNoteExecutor implements ActionExecutor {
  readonly actionType = 'add_note';
  private readonly logger = new Logger(AddNoteExecutor.name);

  constructor(
    private readonly notesService: NotesService,
    private readonly templateEngine: TemplateInterpolationService,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordType, actionConfig, tenantId, recordData } = job;

    const content = this.templateEngine.interpolate(
      actionConfig.content ?? '',
      recordData,
    );

    if (!content.trim()) {
      return {
        success: false,
        retryable: false,
        error: {
          code: 'EMPTY_NOTE',
          message: 'Note content is empty after interpolation',
        },
      };
    }

    const contactId =
      recordType === 'Contact'
        ? recordId
        : recordData.contactId || recordData.relatedContact?.id;

    if (!contactId) {
      return {
        success: false,
        retryable: false,
        error: {
          code: 'NO_CONTACT',
          message:
            `Cannot add a note: ${recordType}(${recordId}) has no related contact. ` +
            'Notes attach to contacts — use a webhook or Create Task instead.',
        },
      };
    }

    this.logger.log(
      `[AddNote] tenant=${tenantId} contactId=${contactId} chars=${content.length}`,
    );

    const note = await this.notesService.createForContact(contactId, {
      content,
      title: `[Automation] ${content.length > 60 ? `${content.slice(0, 60)}...` : content}`,
    } as any);

    return { success: true, output: { noteId: note.id, contactId } };
  }
}

// Create Record

@Injectable()
export class CreateRecordExecutor implements ActionExecutor {
  readonly actionType = 'create_record';
  private readonly logger = new Logger(CreateRecordExecutor.name);

  private static readonly SUPPORTED_TYPES = new Set([
    'Contact',
    'Lead',
    'Deal',
    'Account',
    'Ticket',
    'Task',
  ]);

  constructor(
    private readonly templateEngine: TemplateInterpolationService,
    private readonly contactsService: ContactsService,
    private readonly dealsService: DealsService,
    private readonly ticketsService: TicketsService,
    private readonly tasksService: TasksService,
    private readonly accountsService: AccountsService,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordType, actionConfig, tenantId, recordData } = job;
    const targetType = actionConfig.recordType ?? 'Contact';

    if (!CreateRecordExecutor.SUPPORTED_TYPES.has(targetType)) {
      return {
        success: false,
        retryable: false,
        error: {
          code: 'UNSUPPORTED_RECORD_TYPE',
          message: `Record type "${targetType}" is not supported. Valid: ${[...CreateRecordExecutor.SUPPORTED_TYPES].join(', ')}`,
        },
      };
    }

    let fieldData: Record<string, any>;
    try {
      const raw =
        typeof actionConfig.fieldMappings === 'string'
          ? JSON.parse(actionConfig.fieldMappings)
          : actionConfig.fieldMappings || {};

      fieldData = {};
      for (const [key, val] of Object.entries(raw)) {
        fieldData[key] =
          typeof val === 'string'
            ? this.templateEngine.interpolate(val, recordData)
            : val;
      }
    } catch (err: any) {
      return {
        success: false,
        retryable: false,
        error: {
          code: 'INVALID_FIELD_MAPPINGS',
          message: `Failed to parse fieldMappings: ${err.message}`,
        },
      };
    }

    // Identity / tenancy / audit / ownership fields are refused here. Without
    // this the create path was a way around the update path's denylist: an
    // author could set `ownerId` at birth (an ownership grant that skips the
    // assignment engine) or `orgUnitId` (which decides who can see the record).
    const denied = CrmRecordUpdateService.findDeniedCreateFields(fieldData);
    if (denied.length > 0) {
      this.logger.warn(
        `[CreateRecord] Blocked protected field(s) [${denied.join(', ')}] on ${targetType}`,
      );
      return {
        success: false,
        retryable: false,
        error: {
          code: 'PROTECTED_FIELD',
          message:
            `Field(s) ${denied.join(', ')} cannot be set by automation. ` +
            'To assign a record use a "Route to Team" action, or the assignee ' +
            'option on Create Task / Create Ticket.',
        },
      };
    }

    this.logger.log(
      `[CreateRecord] tenant=${tenantId} type=${targetType} fields=${Object.keys(fieldData).length} triggeredBy=${recordType}(${recordId})`,
    );

    try {
      const created = await this.createByType(targetType, fieldData);
      return {
        success: true,
        output: { recordType: targetType, recordId: created.id },
      };
    } catch (err: any) {
      // A schema rejection is the author's mistake, not a transient fault.
      const retryable =
        err.name !== 'ValidationError' && err.name !== 'CastError';
      return {
        success: false,
        retryable,
        error: { code: 'CREATE_RECORD_FAILED', message: err.message },
      };
    }
  }

  private createByType(
    type: string,
    data: Record<string, any>,
  ): Promise<{ id: string }> {
    switch (type) {
      case 'Contact':
      case 'Lead':
        return this.contactsService.create(data as any);
      case 'Deal':
        return this.dealsService.create(data as any);
      case 'Ticket':
        return this.ticketsService.create(data as any);
      case 'Task':
        return this.tasksService.create(data as any);
      case 'Account':
        return this.accountsService.create(data as any);
      default:
        throw new Error(`Unsupported type: ${type}`);
    }
  }
}
