import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { pagination } from '../utils/pagination';
import { PaginationResponseDto } from '../utils/dto/pagination-response.dto';
import {
  AudienceDefinition,
  assertAudienceShape,
} from '../contacts/audience/audience-definition';
import {
  CampaignDocument,
  CampaignSchemaClass,
  CampaignStatus,
  EDITABLE_CAMPAIGN_STATUSES,
} from './campaign.schema';
import {
  CampaignRecipientSchemaClass,
  RecipientStatus,
} from './campaign-recipient.schema';
import {
  CampaignChannelConfig,
  assertChannelConfig,
} from './domain/campaign-channel';
import { assertValidTimezone, parseHhMm } from './domain/quiet-hours';
import {
  AudiencePreview,
  CampaignAudienceService,
} from './campaign-audience.service';
import { CampaignCodeService } from './campaign-code.service';
import { CampaignProducer } from './queue/campaign.producer';
import { CAMPAIGN_MAX_AUDIENCE } from './campaigns.constants';
import {
  CreateCampaignDto,
  ListCampaignsDto,
  ListRecipientsDto,
  PreviewAudienceDto,
  UpdateCampaignDto,
} from './dto/campaign.dto';

/** The campaign as the API returns it. `runScope` is never part of this. */
export interface CampaignView {
  id: string;
  code: string;
  name: string;
  description?: string;
  objective?: string;
  tags: string[];
  status: CampaignStatus;
  channelType: CampaignChannelConfig['type'];
  channelConfig: CampaignChannelConfig;
  audience: AudienceDefinition;
  schedule: CampaignDocument['schedule'];
  stats: CampaignDocument['stats'];
  budget?: number;
  currency?: string;
  ownerId?: string | null;
  launchedAt?: Date | null;
  completedAt?: Date | null;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Which list-view filter columns are honoured, and how each is matched. */
const LIST_FILTERS: Record<string, 'text' | 'exact' | 'number'> = {
  name: 'text',
  code: 'text',
  status: 'exact',
  channelType: 'exact',
  ownerId: 'exact',
  budget: 'number',
};

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    @InjectModel(CampaignSchemaClass.name)
    private readonly model: Model<CampaignDocument>,
    @InjectModel(CampaignRecipientSchemaClass.name)
    private readonly recipients: Model<CampaignRecipientSchemaClass>,
    private readonly audience: CampaignAudienceService,
    private readonly codes: CampaignCodeService,
    private readonly producer: CampaignProducer,
    private readonly cls: ClsService,
  ) {}

  async list(
    query: ListCampaignsDto,
  ): Promise<PaginationResponseDto<CampaignView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const where = this.buildListWhere(query);
    const sort = this.buildSort(query);

    const [docs, totalItems] = await Promise.all([
      this.model
        .find(where)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.model.countDocuments(where).exec(),
    ]);

    return pagination(
      docs.map((doc) => this.toView(doc)),
      totalItems,
      { page, limit },
    );
  }

  async findById(id: string): Promise<CampaignDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Campaign ${id} not found`);
    }
    const doc = await this.model.findOne({ _id: id, deletedAt: null }).exec();
    if (!doc) throw new NotFoundException(`Campaign ${id} not found`);
    return doc;
  }

  async findOne(id: string): Promise<CampaignView> {
    return this.toView((await this.findById(id)).toObject());
  }

  async create(dto: CreateCampaignDto): Promise<CampaignView> {
    await this.assertDefinitionIsUsable(
      dto.channelType,
      dto.channelConfig,
      dto.audience,
    );
    const userId = this.requireUserId();
    const tenantId = this.requireTenantId();

    const created = await this.model.create({
      tenantId,
      code: await this.codes.next(tenantId),
      name: dto.name.trim(),
      description: dto.description?.trim(),
      objective: dto.objective?.trim(),
      tags: dto.tags ?? [],
      status: 'draft',
      channelType: dto.channelType,
      channelConfig: dto.channelConfig,
      audience: normaliseAudience(dto.audience),
      schedule: this.normaliseSchedule(dto.schedule),
      budget: dto.budget,
      currency: dto.currency,
      ownerId: dto.ownerId ?? userId,
      orgUnitId: this.cls.get<string>('userOrgUnitId') ?? null,
      createdById: userId,
      updatedById: userId,
    });

    return this.toView(created.toObject());
  }

  /**
   * Edit the definition.
   *
   * Refused once a campaign has started, and that is the whole point: the content
   * and audience a run is using are already in flight. Allowing an edit mid-send
   * would produce one campaign that sent two different messages, with no record
   * of which recipient got which.
   */
  async update(id: string, dto: UpdateCampaignDto): Promise<CampaignView> {
    const existing = await this.findById(id);

    const channelType = dto.channelType ?? existing.channelType;
    const channelConfig = dto.channelConfig ?? existing.channelConfig;
    const audience = dto.audience
      ? normaliseAudience(dto.audience)
      : existing.audience;

    // Only a change to what gets sent, to whom, or when is frozen once a run
    // starts. Ownership, tags and notes stay editable for the life of the record
    // — reassigning a finished campaign to a new owner is bookkeeping, and
    // refusing it would break the list view's bulk actions for no safety gain.
    if (
      dto.channelType ||
      dto.channelConfig ||
      dto.audience ||
      dto.schedule !== undefined
    ) {
      this.assertEditable(existing);
      await this.assertDefinitionIsUsable(channelType, channelConfig, audience);
    }

    existing.set({
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.description !== undefined
        ? { description: dto.description.trim() }
        : {}),
      ...(dto.objective !== undefined
        ? { objective: dto.objective.trim() }
        : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
      ...(dto.budget !== undefined ? { budget: dto.budget } : {}),
      ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
      ...(dto.ownerId !== undefined ? { ownerId: dto.ownerId } : {}),
      ...(dto.schedule !== undefined
        ? { schedule: this.normaliseSchedule(dto.schedule) }
        : {}),
      channelType,
      channelConfig,
      audience,
      updatedById: this.requireUserId(),
    });
    await existing.save();

    return this.toView(existing.toObject());
  }

  /** Archive. Soft, because the recipient ledger references this document. */
  async remove(id: string): Promise<void> {
    const existing = await this.findById(id);
    if (existing.status === 'sending') {
      throw new ConflictException(
        'This campaign is still sending. Pause or cancel it before deleting.',
      );
    }
    existing.set({ deletedAt: new Date(), updatedById: this.requireUserId() });
    await existing.save();
  }

  /**
   * Copy a campaign back to draft.
   *
   * Stats and schedule are deliberately NOT copied: a duplicate has sent nothing,
   * and inheriting a send time in the past would make it look overdue.
   */
  async duplicate(id: string): Promise<CampaignView> {
    const source = await this.findById(id);
    const userId = this.requireUserId();
    const tenantId = this.requireTenantId();

    const created = await this.model.create({
      tenantId,
      code: await this.codes.next(tenantId),
      name: `${source.name} (copy)`,
      description: source.description,
      objective: source.objective,
      tags: source.tags,
      status: 'draft',
      channelType: source.channelType,
      channelConfig: source.channelConfig,
      audience: source.audience,
      schedule: {
        sendAt: null,
        timezone: source.schedule?.timezone ?? 'UTC',
        quietHours: source.schedule?.quietHours ?? null,
      },
      budget: source.budget,
      currency: source.currency,
      ownerId: userId,
      orgUnitId: this.cls.get<string>('userOrgUnitId') ?? null,
      createdById: userId,
      updatedById: userId,
    });

    return this.toView(created.toObject());
  }

  /**
   * Size an unsaved audience, so the wizard can show a number as it is built.
   *
   * Resolving the definition is also the tenant check: every segment lookup
   * inside it is tenant-filtered, so an id from another tenant is a 404 here
   * rather than a count of somebody else's contacts. The result is narrowed by
   * the caller's own data scope, which is why it can differ between two people
   * looking at the same segment — the response says so explicitly.
   */
  async previewAudience(dto: PreviewAudienceDto): Promise<AudiencePreview> {
    const filter = await this.audience.buildFilter(dto.audience);
    return this.audience.preview(filter, dto.channelType);
  }

  /**
   * Start the campaign, or arm it for its scheduled time.
   *
   * The audience is counted here, before anything is queued, so the two failures
   * that cannot be undone later are caught while there is still someone watching:
   * an empty audience (a segment that matches nobody, usually a mistake) and an
   * absurdly large one (a condition tree that compiled away and selected the
   * whole tenant).
   */
  async launch(id: string): Promise<CampaignView> {
    const campaign = await this.findById(id);
    if (!EDITABLE_CAMPAIGN_STATUSES.includes(campaign.status)) {
      throw new ConflictException(
        `A campaign that is ${campaign.status} cannot be launched again.`,
      );
    }

    assertChannelConfig(campaign.channelConfig);

    // Compiled once and kept: the count below and the run itself must be about
    // the same set of people, and re-resolving would open a window in which a
    // segment edit changes who gets messaged after the check has passed.
    const predicate = await this.audience.buildFilter(campaign.audience);
    const total = await this.assertSendableSize(predicate);

    const sendAt = campaign.schedule?.sendAt
      ? new Date(campaign.schedule.sendAt)
      : null;
    const isFuture = Boolean(sendAt && sendAt.getTime() > Date.now());

    campaign.set({
      status: isFuture ? 'scheduled' : 'sending',
      launchedAt: new Date(),
      completedAt: null,
      lastError: undefined,
      // Reset rather than accumulate: relaunching a cancelled campaign starts a
      // fresh run, and its old counters would double-count the ledger.
      stats: { audienceSize: 0, queued: 0, sent: 0, failed: 0, skipped: 0 },
      audienceSnapshot: {
        definition: campaign.audience,
        predicate,
        frozenAt: new Date(),
      },
      runScope: this.captureScope(),
      updatedById: this.requireUserId(),
    });
    await campaign.save();

    if (!isFuture) {
      await this.producer.enqueueDispatch(
        String(campaign._id),
        String(campaign.tenantId),
        campaign.runScope ?? undefined,
      );
    }

    this.logger.log(
      `Campaign ${campaign.code} launched (${isFuture ? `scheduled for ${sendAt?.toISOString()}` : 'immediate'}, audience ${total})`,
    );

    return this.toView(campaign.toObject());
  }

  /**
   * Stop sending.
   *
   * Batches already claimed finish what they are doing; nothing new is claimed,
   * because every send job re-reads the campaign status before touching a
   * recipient. Killing in-flight sends instead would leave recipients stuck in
   * `sending` with a message that may or may not have gone out.
   */
  async pause(id: string): Promise<CampaignView> {
    const campaign = await this.findById(id);
    if (campaign.status !== 'sending') {
      throw new ConflictException(
        `Only a sending campaign can be paused; this one is ${campaign.status}.`,
      );
    }
    campaign.set({ status: 'paused', updatedById: this.requireUserId() });
    await campaign.save();
    return this.toView(campaign.toObject());
  }

  /**
   * Carry on from where the pause left off.
   *
   * Re-dispatching is safe and is the whole reason the ledger exists: the
   * dispatch job skips materialisation when the audience is already recorded and
   * simply re-queues the rows still `pending`.
   */
  async resume(id: string): Promise<CampaignView> {
    const campaign = await this.findById(id);
    if (campaign.status !== 'paused') {
      throw new ConflictException(
        `Only a paused campaign can be resumed; this one is ${campaign.status}.`,
      );
    }

    // A campaign that paused itself because its audience outgrew the ceiling
    // would otherwise re-materialise, hit the same ceiling and pause again on
    // every resume — a loop with a button on it. Re-checking here turns that
    // into one refusal a person can read.
    if (!campaign.stats?.audienceSize) {
      await this.assertSendableSize(await this.runPredicate(campaign));
    }

    campaign.set({
      status: 'sending',
      lastError: undefined,
      runScope: this.captureScope(),
      updatedById: this.requireUserId(),
    });
    await campaign.save();

    await this.producer.enqueueDispatch(
      String(campaign._id),
      String(campaign.tenantId),
      campaign.runScope ?? undefined,
    );

    return this.toView(campaign.toObject());
  }

  async cancel(id: string): Promise<CampaignView> {
    const campaign = await this.findById(id);
    if (!['scheduled', 'sending', 'paused'].includes(campaign.status)) {
      throw new ConflictException(
        `A campaign that is ${campaign.status} cannot be cancelled.`,
      );
    }

    campaign.set({
      status: 'cancelled',
      completedAt: new Date(),
      updatedById: this.requireUserId(),
    });
    await campaign.save();

    // Whatever was never attempted is now skipped, so the ledger adds up: every
    // row is terminal and `audienceSize` still equals the sum of the outcomes.
    const { modifiedCount } = await this.recipients
      .updateMany(
        { campaignId: campaign._id, status: { $in: ['pending', 'sending'] } },
        { $set: { status: 'skipped', skipReason: null } },
      )
      .exec();

    if (modifiedCount) {
      await this.model
        .updateOne(
          { _id: campaign._id },
          { $inc: { 'stats.skipped': modifiedCount } },
        )
        .exec();
    }

    return this.toView(campaign.toObject());
  }

  /**
   * Put failed recipients back in the queue.
   *
   * A separate action rather than an automatic retry: the usual cause of a batch
   * of failures is a configuration problem, and retrying on a timer would empty
   * a provider quota against an error nobody has looked at yet.
   */
  async retryFailed(id: string): Promise<{ queued: number }> {
    const campaign = await this.findById(id);
    if (!['completed', 'paused', 'cancelled'].includes(campaign.status)) {
      throw new ConflictException(
        'Wait for the campaign to finish before retrying its failures.',
      );
    }

    const { modifiedCount } = await this.recipients
      .updateMany(
        { campaignId: campaign._id, status: 'failed' },
        { $set: { status: 'pending', error: null } },
      )
      .exec();

    if (!modifiedCount) return { queued: 0 };

    campaign.set({
      status: 'sending',
      completedAt: null,
      lastError: undefined,
      runScope: this.captureScope(),
      updatedById: this.requireUserId(),
    });
    await campaign.save();

    await this.model
      .updateOne(
        { _id: campaign._id },
        { $inc: { 'stats.failed': -modifiedCount } },
      )
      .exec();

    await this.producer.enqueueDispatch(
      String(campaign._id),
      String(campaign.tenantId),
      campaign.runScope ?? undefined,
    );

    return { queued: modifiedCount };
  }

  async listRecipients(id: string, query: ListRecipientsDto) {
    const campaign = await this.findById(id);
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const where: FilterQuery<CampaignRecipientSchemaClass> = {
      campaignId: campaign._id,
      ...(query.status ? { status: query.status } : {}),
    };

    const [docs, totalItems] = await Promise.all([
      this.recipients
        .find(where)
        .sort({ _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('contactId', 'firstName lastName companyName')
        .lean()
        .exec(),
      this.recipients.countDocuments(where).exec(),
    ]);

    return pagination(
      docs.map((doc: any) => ({
        id: String(doc._id),
        contactId: doc.contactId?._id
          ? String(doc.contactId._id)
          : String(doc.contactId),
        contactName: doc.contactId?.firstName
          ? [doc.contactId.firstName, doc.contactId.lastName]
              .filter(Boolean)
              .join(' ')
          : null,
        destination: doc.destination ?? null,
        status: doc.status as RecipientStatus,
        skipReason: doc.skipReason ?? null,
        error: doc.error ?? null,
        sentAt: doc.sentAt ?? null,
      })),
      totalItems,
      { page, limit },
    );
  }

  private assertEditable(campaign: CampaignDocument): void {
    if (!EDITABLE_CAMPAIGN_STATUSES.includes(campaign.status)) {
      throw new ConflictException(
        `A campaign that is ${campaign.status} can no longer be edited. Duplicate it to make changes.`,
      );
    }
  }

  /**
   * The audience must resolve before the campaign is stored, not at send time.
   *
   * Compiling it here proves three things at once: every segment referenced
   * exists and belongs to the caller's tenant (the lookups are tenant-filtered,
   * so an id from elsewhere is a 404 rather than somebody else's audience),
   * every inline condition uses a real field and a legal operator, and the whole
   * thing produces a predicate. A campaign that could only fail in a worker is
   * refused while there is still someone reading the response.
   */
  private async assertDefinitionIsUsable(
    channelType: string,
    channelConfig: unknown,
    audience: AudienceDefinition,
  ): Promise<void> {
    assertChannelConfig(channelConfig);
    if ((channelConfig as CampaignChannelConfig).type !== channelType) {
      throw new BadRequestException(
        'The channel configuration does not match the selected channel.',
      );
    }
    await this.audience.buildFilter(audience);
  }

  /**
   * Refuse the two audience sizes that cannot be recovered from later: nobody,
   * and far too many.
   *
   * An empty audience is nearly always a condition that matched nothing and a
   * marketer who has not noticed. A vast one is nearly always a definition that
   * compiled away and selected the whole tenant — and finding that out from the
   * provider's abuse team costs more than a refused launch.
   */
  private async assertSendableSize(
    predicate: FilterQuery<Record<string, unknown>>,
  ): Promise<number> {
    const total = await this.audience.count(predicate as any);

    if (total === 0) {
      throw new BadRequestException(
        'This campaign’s audience is empty. Nobody would receive it.',
      );
    }
    if (total > CAMPAIGN_MAX_AUDIENCE) {
      throw new BadRequestException(
        `This campaign would reach ${total.toLocaleString()} contacts, above the ${CAMPAIGN_MAX_AUDIENCE.toLocaleString()} limit. Narrow the audience.`,
      );
    }
    return total;
  }

  /**
   * The predicate a started run is bound to.
   *
   * Read back explicitly because `audienceSnapshot` is `select: false` — it is
   * an internal detail of the run, not part of the campaign anyone reads.
   */
  private async runPredicate(
    campaign: CampaignDocument,
  ): Promise<FilterQuery<Record<string, unknown>>> {
    const frozen = await this.model
      .findOne({ _id: campaign._id })
      .select('+audienceSnapshot')
      .lean()
      .exec();

    const predicate = frozen?.audienceSnapshot?.predicate;
    if (!predicate) {
      throw new ConflictException(
        'This campaign has no frozen audience. Launch it again.',
      );
    }
    return predicate;
  }

  private normaliseSchedule(
    schedule: CreateCampaignDto['schedule'],
  ): CampaignDocument['schedule'] {
    const timezone = schedule?.timezone?.trim() || 'UTC';
    assertValidTimezone(timezone);

    if (schedule?.quietHours) {
      const start = parseHhMm(schedule.quietHours.start, 'Quiet hours start');
      const end = parseHhMm(schedule.quietHours.end, 'Quiet hours end');
      if (start === end) {
        throw new BadRequestException(
          'Quiet hours must start and end at different times.',
        );
      }
    }

    return {
      sendAt: schedule?.sendAt ? new Date(schedule.sendAt) : null,
      timezone,
      quietHours: schedule?.quietHours ?? null,
    };
  }

  private buildListWhere(
    query: ListCampaignsDto,
  ): FilterQuery<CampaignSchemaClass> {
    const clauses: FilterQuery<CampaignSchemaClass>[] = [{ deletedAt: null }];

    if (query.status) clauses.push({ status: query.status });

    if (query.search?.trim()) {
      const pattern = escapeRegex(query.search.trim());
      // An unanchored regex, which is a scan — but bounded to one tenant's
      // campaigns by the list index, and a tenant has hundreds of campaigns, not
      // millions of them. A search index here would cost more than it saves.
      clauses.push({
        $or: [
          { name: { $regex: pattern, $options: 'i' } },
          { code: { $regex: pattern, $options: 'i' } },
        ],
      });
    }

    for (const entry of parseListFilters(query.filters)) {
      const kind = LIST_FILTERS[entry.id];
      if (!kind) continue; // An unknown column narrows nothing rather than throwing.

      if (kind === 'text') {
        clauses.push({
          [entry.id]: {
            $regex: escapeRegex(String(entry.value)),
            $options: 'i',
          },
        });
      } else if (kind === 'number') {
        const value = Number(entry.value);
        if (Number.isFinite(value)) clauses.push({ [entry.id]: value });
      } else if (Array.isArray(entry.value)) {
        clauses.push({ [entry.id]: { $in: entry.value.map(String) } });
      } else {
        clauses.push({ [entry.id]: String(entry.value) });
      }
    }

    return clauses.length === 1 ? clauses[0] : { $and: clauses };
  }

  private buildSort(query: ListCampaignsDto): Record<string, 1 | -1> {
    const direction = query.sortOrder === 'asc' ? 1 : -1;
    const field = query.sortBy ?? 'createdAt';
    // `_id` as a tiebreaker so two campaigns created in the same millisecond do
    // not swap places between pages and hide a row.
    return { [field]: direction, _id: direction };
  }

  private captureScope(): Record<string, unknown> {
    return {
      visibleOwnerIds: this.cls.get('visibleOwnerIds') ?? null,
      visibleOrgUnitIds: this.cls.get('visibleOrgUnitIds') ?? null,
      dataVisibilityByModule: this.cls.get('dataVisibilityByModule') ?? null,
      includeUnownedInScope: this.cls.get('includeUnownedInScope') === true,
      abacResourceFilter: this.cls.get('abacResourceFilter') ?? null,
    };
  }

  private toView(doc: Record<string, any>): CampaignView {
    return {
      id: String(doc._id),
      code: doc.code,
      name: doc.name,
      description: doc.description,
      objective: doc.objective,
      tags: doc.tags ?? [],
      status: doc.status,
      channelType: doc.channelType,
      channelConfig: doc.channelConfig,
      audience: doc.audience,
      schedule: doc.schedule,
      stats: doc.stats,
      budget: doc.budget,
      currency: doc.currency,
      ownerId: doc.ownerId ? String(doc.ownerId) : null,
      launchedAt: doc.launchedAt ?? null,
      completedAt: doc.completedAt ?? null,
      lastError: doc.lastError,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  private requireTenantId(): string {
    const tenantId =
      this.cls.get<string>('activeTenantId') ??
      this.cls.get<string>('tenantId');
    if (!tenantId) throw new BadRequestException('Tenant context is required.');
    return tenantId;
  }

  private requireUserId(): string {
    const userId =
      this.cls.get<string>('userId') ?? this.cls.get<string>('user.id');
    if (!userId) throw new BadRequestException('User context is required.');
    return userId;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Store an audience in one shape, whatever the client sent.
 *
 * `exclude` is normalised to an array rather than left undefined so every read
 * — including the segment delete guard's `audience.exclude.segmentId` query —
 * sees the same document shape.
 */
function normaliseAudience(audience: AudienceDefinition): AudienceDefinition {
  assertAudienceShape(audience);
  return { include: audience.include, exclude: audience.exclude ?? [] };
}

/** The list view's `[{ id, value }]` array. Malformed JSON narrows nothing. */
function parseListFilters(raw?: string): Array<{ id: string; value: unknown }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry) =>
            entry &&
            typeof entry.id === 'string' &&
            entry.value !== undefined &&
            entry.value !== '' &&
            !(Array.isArray(entry.value) && entry.value.length === 0),
        )
      : [];
  } catch {
    throw new BadRequestException('Malformed filter expression');
  }
}
