import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  TicketStatusDocument,
  TicketStatusSchemaClass,
} from './entities/ticket-status.schema';
import {
  TicketTypeDocument,
  TicketTypeSchemaClass,
} from './entities/ticket-type.schema';
import {
  TicketSourceDocument,
  TicketSourceSchemaClass,
} from './entities/ticket-source.schema';
import {
  TicketResolutionCodeDocument,
  TicketResolutionCodeSchemaClass,
} from './entities/ticket-resolution-code.schema';

/**
 * The default support workflow.
 *
 * `terminalKind` is the field that makes Resolved and Closed distinct outcomes,
 * and `pausesSla` is what stops the clock while the customer is the one who
 * owes a reply. A desk configured without either cannot report a defensible
 * response time.
 */
const DEFAULT_STATUSES = [
  {
    label: 'New',
    apiName: 'new',
    color: '#3b82f6',
    isDefault: true,
    isTerminal: false,
    terminalKind: null,
    pausesSla: false,
  },
  {
    label: 'In Progress',
    apiName: 'open',
    color: '#eab308',
    isDefault: false,
    isTerminal: false,
    terminalKind: null,
    pausesSla: false,
  },
  {
    label: 'Waiting on Customer',
    apiName: 'on_hold',
    color: '#f59e0b',
    isDefault: false,
    isTerminal: false,
    terminalKind: null,
    pausesSla: true,
  },
  {
    label: 'Resolved',
    apiName: 'resolved',
    color: '#10b981',
    isDefault: false,
    isTerminal: true,
    terminalKind: 'resolved' as const,
    pausesSla: false,
  },
  {
    label: 'Closed',
    apiName: 'closed',
    color: '#64748b',
    isDefault: false,
    isTerminal: true,
    terminalKind: 'closed' as const,
    pausesSla: false,
  },
] as const;

/** The request kinds a support desk actually receives. */
const DEFAULT_TYPES = [
  { name: 'Support Request', apiName: 'support', color: '#3b82f6' },
  { name: 'Complaint', apiName: 'complaint', color: '#ef4444' },
  { name: 'Technical Issue', apiName: 'technical', color: '#8b5cf6' },
  { name: 'Billing Issue', apiName: 'billing', color: '#f59e0b' },
  { name: 'Feature Request', apiName: 'feature_request', color: '#10b981' },
  { name: 'Internal Request', apiName: 'internal', color: '#64748b' },
] as const;

/** Where a case came in from, so channel analytics has buckets on day one. */
const DEFAULT_SOURCES = [
  'WhatsApp',
  'Facebook',
  'Instagram',
  'Live Chat',
  'Email',
  'Phone',
  'Walk-in',
] as const;

const DEFAULT_RESOLUTION_CODES = [
  { name: 'Resolved by Agent', apiName: 'resolved_by_agent' },
  { name: 'Resolved by Customer', apiName: 'resolved_by_customer' },
  { name: 'Duplicate', apiName: 'duplicate' },
  { name: 'Not Reproducible', apiName: 'not_reproducible' },
  { name: 'Out of Scope', apiName: 'out_of_scope' },
  { name: 'No Response from Customer', apiName: 'no_response' },
] as const;

/**
 * Materialises a workspace's ticket statuses, types, sources and resolution
 * codes as real documents.
 *
 * The collections are the authority: a ticket's `statusId` is required and
 * references `ticket_statuses`, so a workflow that exists only as a settings
 * blob leaves a fresh tenant unable to create a ticket at all. Same shape and
 * same reason as `DealPipelineSeederService`.
 *
 * Idempotent — the tenant-created listener replays every step on retry.
 */
@Injectable()
export class TicketSettingsSeederService {
  private readonly logger = new Logger(TicketSettingsSeederService.name);

  constructor(
    @InjectModel(TicketStatusSchemaClass.name)
    private readonly statusModel: Model<TicketStatusDocument>,
    @InjectModel(TicketTypeSchemaClass.name)
    private readonly typeModel: Model<TicketTypeDocument>,
    @InjectModel(TicketSourceSchemaClass.name)
    private readonly sourceModel: Model<TicketSourceDocument>,
    @InjectModel(TicketResolutionCodeSchemaClass.name)
    private readonly resolutionModel: Model<TicketResolutionCodeDocument>,
  ) {}

  async seedForTenant(tenantId: string): Promise<void> {
    const tenant = new Types.ObjectId(tenantId);

    const existing = await this.statusModel
      .findOne({ tenantId: tenant })
      .setOptions({ isPlatformQuery: true } as any)
      .select({ _id: 1 })
      .lean()
      .exec();
    if (existing) return;

    await this.statusModel.insertMany(
      DEFAULT_STATUSES.map((status, index) => ({
        ...status,
        tenantId: tenant,
        sortOrder: index + 1,
      })),
    );
    await this.typeModel.insertMany(
      DEFAULT_TYPES.map((type, index) => ({
        ...type,
        tenantId: tenant,
        sortOrder: index + 1,
      })),
    );
    await this.sourceModel.insertMany(
      DEFAULT_SOURCES.map((name, index) => ({
        tenantId: tenant,
        name,
        sortOrder: index + 1,
      })),
    );
    await this.resolutionModel.insertMany(
      DEFAULT_RESOLUTION_CODES.map((code) => ({ ...code, tenantId: tenant })),
    );

    this.logger.log(
      `Seeded ticket workflow for tenant ${tenantId} ` +
        `(${DEFAULT_STATUSES.length} statuses, ${DEFAULT_TYPES.length} types)`,
    );
  }
}
