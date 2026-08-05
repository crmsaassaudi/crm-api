import { Injectable, Logger } from '@nestjs/common';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { AccountSettingsService } from '../../account-settings/account-settings.service';
import { DealSettingsService } from '../../deal-settings/deal-settings.service';
import { TaskSettingsService } from '../../task-settings/task-settings.service';
import { TicketSettingsService } from '../../ticket-settings/ticket-settings.service';
import { ConfigurableObject } from '../object-registry';

export interface PicklistOption {
  label: string;
  value: string;
  color?: string;
}

/** Payload field key → its allowed values. */
export type ObjectPicklists = Record<string, PicklistOption[]>;

/**
 * The allowed values for each standard picklist field, read from whichever store
 * the runtime actually validates against.
 *
 * The split-brain this closes
 *
 * Object Manager's Status & Sources tab wrote `crm-settings/{object}_lifecycle`
 * and `{object}_source` — plain JSON blobs. But `TicketsService.validateTenantReferences`
 * checks `statusId` against the `ticket_statuses` *collection*, `TaskReferenceValidator`
 * checks it against `task_statuses`, and both DTOs declare `@IsMongoId()`. The blob
 * seeds ids like `'new'` and mints `ulid()` for admin-created rows, so a status
 * chosen in the ticket form was rejected with 400 before it reached the service.
 * Filtering the ticket list by such a status failed the same way. For Deal and
 * Account, which validate nothing, the id was accepted and then failed to resolve
 * anywhere — a record with a stage the pipeline board could not name.
 *
 * The store the runtime enforces is the authoritative one, so that is the store
 * read here and the store Object Manager now writes. Contact is the exception and
 * deliberately so: its authority has always been `contact_lifecycle`, and
 * `CrmSettingsService` guards stage/status renames against live references. Moving
 * Contact would be a data migration with no correctness gain.
 *
 * Why the field descriptor carries its options
 *
 * Because the alternative is what produced the bug: a form that fetches its
 * picklists from one endpoint while the field's rules come from another, with
 * nothing asserting the two describe the same field. Attaching options to the
 * descriptor keyed by payload key means a mismatch cannot be expressed.
 */
@Injectable()
export class PicklistProvider {
  private readonly logger = new Logger(PicklistProvider.name);

  constructor(
    private readonly settings: CrmSettingsService,
    private readonly ticketSettings: TicketSettingsService,
    private readonly taskSettings: TaskSettingsService,
    private readonly accountSettings: AccountSettingsService,
    private readonly dealSettings: DealSettingsService,
  ) {}

  async forObject(object: ConfigurableObject): Promise<ObjectPicklists> {
    try {
      switch (object) {
        case 'Contact':
          return await this.contactPicklists();
        case 'Account':
          return await this.accountPicklists();
        case 'Deal':
          return await this.dealPicklists();
        case 'Ticket':
          return await this.ticketPicklists();
        case 'Task':
          return await this.taskPicklists();
      }
    } catch (error) {
      // A picklist read failure degrades the form to a free-text-ish state rather
      // than failing the whole config request. Returning `{}` is honest: "no
      // options known", which the client renders as an empty select — visibly
      // wrong, which is what an operator needs to see.
      this.logger.error(
        `Could not load picklists for ${object}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return {};
    }
  }

  /** Contact keeps its lifecycle blob: `crm_settings` is its authority. */
  private async contactPicklists(): Promise<ObjectPicklists> {
    const [lifecycle, source] = await Promise.all([
      this.settings.getSetting('contact_lifecycle'),
      this.settings.getSetting('contact_source'),
    ]);

    const stages = asArray(lifecycle?.stages);
    return {
      lifecycleStageId: stages.map((stage) => ({
        label: String(stage?.name ?? ''),
        value: String(stage?.id ?? ''),
        color: stage?.color,
      })),
      statusId: stages
        .flatMap((stage) => asArray(stage?.statuses))
        .map((status) => ({
          label: String(status?.label ?? ''),
          value: String(status?.id ?? ''),
          color: status?.color,
        })),
      sourceId: asArray(source?.sources).map((entry) => ({
        label: String(entry?.name ?? entry?.label ?? ''),
        value: String(entry?.id ?? ''),
      })),
    };
  }

  private async accountPicklists(): Promise<ObjectPicklists> {
    const [statuses, types] = await Promise.all([
      this.accountSettings.findAllStatuses(),
      this.accountSettings.findAllTypes(),
    ]);
    return {
      statusId: statuses.map(toOption),
      typeId: types.map(toOption),
    };
  }

  private async dealPicklists(): Promise<ObjectPicklists> {
    const [stages, sources] = await Promise.all([
      this.dealSettings.findAllStages(),
      this.dealSettings.findAllSources(),
    ]);
    return {
      stageId: stages.map(toOption),
      sourceId: sources.map(toOption),
    };
  }

  private async ticketPicklists(): Promise<ObjectPicklists> {
    const [statuses, types, sources, resolutionCodes] = await Promise.all([
      this.ticketSettings.findAllStatuses(),
      this.ticketSettings.findAllTypes(),
      this.ticketSettings.findAllSources(),
      this.ticketSettings.findAllResolutionCodes(),
    ]);
    return {
      statusId: statuses.map(toOption),
      typeId: types.map(toOption),
      sourceId: sources.map(toOption),
      resolutionCodeId: resolutionCodes.map(toOption),
    };
  }

  private async taskPicklists(): Promise<ObjectPicklists> {
    const [statuses, categories, sources] = await Promise.all([
      this.taskSettings.findAllStatuses(),
      this.taskSettings.findAllCategories(),
      this.taskSettings.findAllSources(),
    ]);
    return {
      statusId: statuses.map(toOption),
      categoryId: categories.map(toOption),
      sourceId: sources.map(toOption),
    };
  }
}

const asArray = (value: unknown): any[] => (Array.isArray(value) ? value : []);

/**
 * Settings documents are inconsistent about `name` vs `label` — the collections
 * use both depending on which module defined them — so both are accepted rather
 * than normalising one away and breaking the other module's screens.
 */
const toOption = (doc: any): PicklistOption => ({
  label: String(doc?.label ?? doc?.name ?? ''),
  value: String(doc?.id ?? doc?._id ?? ''),
  ...(doc?.color ? { color: String(doc.color) } : {}),
});
