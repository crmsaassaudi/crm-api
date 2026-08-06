import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import {
  DealStageSchemaClass,
  DealStageDocument,
} from './entities/deal-stage.schema';
import {
  DealSourceSchemaClass,
  DealSourceDocument,
} from './entities/deal-source.schema';
import {
  PipelineSchemaClass,
  PipelineDocument,
} from './entities/pipeline.schema';
import {
  CreateDealSourceDto,
  CreateDealStageDto,
  CreatePipelineDto,
  UpdateDealSourceDto,
  UpdateDealStageDto,
  UpdatePipelineDto,
} from './dto/deal-settings.dto';

/** Where a new deal lands when the caller does not name a stage. */
export interface DealPlacement {
  pipelineId: string;
  stageId: string;
  probability: number;
  isWon: boolean;
  isLost: boolean;
}

/** Slugify a label into a stable machine name. */
const toApiName = (label: string): string =>
  label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'stage';

@Injectable()
export class DealSettingsService {
  constructor(
    @InjectModel(DealStageSchemaClass.name)
    private readonly stageModel: Model<DealStageDocument>,
    @InjectModel(DealSourceSchemaClass.name)
    private readonly sourceModel: Model<DealSourceDocument>,
    @InjectModel(PipelineSchemaClass.name)
    private readonly pipelineModel: Model<PipelineDocument>,
    private readonly cls: ClsService,
  ) {}

  private get tenantId(): string {
    return this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
  }

  /**
   * Deals in this tenant, counted without importing DealsModule.
   *
   * A direct collection read rather than a model injection: DealsModule already
   * imports deal-settings for its stage lookups, so injecting the deal model here
   * would close a require cycle. The tenant predicate is applied explicitly
   * because a raw collection has no schema plugin.
   */
  private dealCollection() {
    return this.stageModel.db.collection('deals');
  }

  private async countDealsReferencing(
    field: 'stageId' | 'sourceId' | 'pipelineId',
    id: string,
  ): Promise<number> {
    return this.dealCollection().countDocuments(
      {
        tenantId: new Types.ObjectId(this.tenantId),
        [field]: new Types.ObjectId(id),
        deletedAt: null,
      },
      { limit: 1 },
    );
  }

  // Stages

  findAllStages(pipelineId?: string) {
    const filter: Record<string, unknown> = { tenantId: this.tenantId };
    if (pipelineId) filter.pipelineId = pipelineId;
    return this.stageModel.find(filter).sort({ sortOrder: 1, _id: 1 }).exec();
  }

  async createStage(dto: CreateDealStageDto) {
    await this.findPipelineById(dto.pipelineId);
    const apiName = dto.apiName ?? toApiName(dto.label);

    if (dto.isWon && dto.isLost) {
      throw new BadRequestException(
        'A stage cannot be both a won and a lost outcome.',
      );
    }

    const last = await this.stageModel
      .findOne({ tenantId: this.tenantId, pipelineId: dto.pipelineId })
      .sort({ sortOrder: -1 })
      .select('sortOrder')
      .lean()
      .exec();

    try {
      const created = await this.stageModel.create({
        ...dto,
        apiName,
        sortOrder: dto.sortOrder ?? (last?.sortOrder ?? -1) + 1,
        tenantId: this.tenantId,
      });
      if (dto.isDefault)
        await this.demoteOtherDefaults(dto.pipelineId, created.id);
      return created;
    } catch (error) {
      throw this.translateDuplicateKey(error, apiName);
    }
  }

  async updateStage(id: string, dto: UpdateDealStageDto) {
    const stage = await this.findStageById(id);
    if (dto.isWon && dto.isLost) {
      throw new BadRequestException(
        'A stage cannot be both a won and a lost outcome.',
      );
    }

    const updated = await this.stageModel
      .findOneAndUpdate(
        { _id: id, tenantId: this.tenantId },
        { $set: dto },
        { new: true },
      )
      .exec();
    if (!updated) throw new NotFoundException(`Stage ${id} not found`);

    if (dto.isDefault) {
      await this.demoteOtherDefaults(String(stage.pipelineId), id);
    }
    return updated;
  }

  /**
   * Refuse to delete a stage deals still sit in.
   *
   * The delete was unconditional, so removing a stage left every deal in it
   * pointing at an id nothing could resolve: the card vanished from the board,
   * the detail page rendered a blank stage, and the reopen guard treated the deal
   * as never closed. There is no safe automatic answer to "where do these go", so
   * the operator moves them first.
   */
  async deleteStage(id: string): Promise<void> {
    const stage = await this.findStageById(id);

    const inUse = await this.countDealsReferencing('stageId', id);
    if (inUse > 0) {
      throw new ConflictException(
        `Stage "${stage.label}" still has deals in it. Move them to another stage first.`,
      );
    }

    const remaining = await this.stageModel.countDocuments({
      tenantId: this.tenantId,
      pipelineId: stage.pipelineId,
      _id: { $ne: id },
    });
    if (remaining === 0) {
      throw new ConflictException(
        'A pipeline must keep at least one stage. Archive the pipeline instead.',
      );
    }

    await this.stageModel
      .deleteOne({ _id: id, tenantId: this.tenantId })
      .exec();
  }

  /** Persist a drag-to-reorder in one round trip. */
  async reorderStages(pipelineId: string, stageIds: string[]) {
    await this.findPipelineById(pipelineId);
    const operations = stageIds.map((stageId, index) => ({
      updateOne: {
        filter: {
          _id: new Types.ObjectId(stageId),
          tenantId: new Types.ObjectId(this.tenantId),
          pipelineId: new Types.ObjectId(pipelineId),
        },
        update: { $set: { sortOrder: index } },
      },
    }));
    if (operations.length > 0) await this.stageModel.bulkWrite(operations);
    return this.findAllStages(pipelineId);
  }

  async findStageById(id: string) {
    const stage = await this.stageModel
      .findOne({ _id: id, tenantId: this.tenantId })
      .exec();
    if (!stage) throw new NotFoundException(`Stage ${id} not found`);
    return stage;
  }

  private async demoteOtherDefaults(pipelineId: string, keepId: string) {
    await this.stageModel
      .updateMany(
        {
          tenantId: this.tenantId,
          pipelineId,
          isDefault: true,
          _id: { $ne: keepId },
        },
        { $set: { isDefault: false } },
      )
      .exec();
  }

  // Sources

  findAllSources() {
    return this.sourceModel
      .find({ tenantId: this.tenantId })
      .sort({ sortOrder: 1, _id: 1 })
      .exec();
  }

  createSource(dto: CreateDealSourceDto) {
    return this.sourceModel.create({ ...dto, tenantId: this.tenantId });
  }

  async updateSource(id: string, dto: UpdateDealSourceDto) {
    const updated = await this.sourceModel
      .findOneAndUpdate(
        { _id: id, tenantId: this.tenantId },
        { $set: dto },
        { new: true },
      )
      .exec();
    if (!updated) throw new NotFoundException(`Source ${id} not found`);
    return updated;
  }

  async deleteSource(id: string): Promise<void> {
    const inUse = await this.countDealsReferencing('sourceId', id);
    if (inUse > 0) {
      throw new ConflictException(
        'This source is still attributed to deals. Reassign them before deleting it.',
      );
    }
    const result = await this.sourceModel
      .deleteOne({ _id: id, tenantId: this.tenantId })
      .exec();
    if (result.deletedCount === 0) {
      throw new NotFoundException(`Source ${id} not found`);
    }
  }

  // Pipelines

  findAllPipelines() {
    return this.pipelineModel
      .find({ tenantId: this.tenantId, isArchived: false })
      .sort({ isDefault: -1, sortOrder: 1 })
      .exec();
  }

  async findPipelineById(id: string) {
    const pipeline = await this.pipelineModel
      .findOne({ _id: id, tenantId: this.tenantId })
      .exec();
    if (!pipeline) throw new NotFoundException(`Pipeline ${id} not found`);
    return pipeline;
  }

  async createPipeline(dto: CreatePipelineDto) {
    const tenantId = this.tenantId;
    const count = await this.pipelineModel.countDocuments({ tenantId });
    const isDefault = dto.isDefault ?? count === 0;

    if (isDefault) {
      await this.pipelineModel.updateMany(
        { tenantId, isDefault: true },
        { $set: { isDefault: false } },
      );
    }

    return this.pipelineModel.create({ ...dto, tenantId, isDefault });
  }

  async updatePipeline(id: string, dto: UpdatePipelineDto) {
    const tenantId = this.tenantId;

    if (dto.isDefault === true) {
      await this.pipelineModel.updateMany(
        { tenantId, isDefault: true, _id: { $ne: id } },
        { $set: { isDefault: false } },
      );
    }

    const updated = await this.pipelineModel
      .findOneAndUpdate({ _id: id, tenantId }, { $set: dto }, { new: true })
      .exec();
    if (!updated) throw new NotFoundException(`Pipeline ${id} not found`);
    return updated;
  }

  /**
   * Archiving hides a pipeline from every selector, so a pipeline that still
   * holds deals would take them out of reach — and the default pipeline is where
   * un-placed deals land, so it may never be archived while it holds that role.
   */
  async archivePipeline(id: string): Promise<void> {
    const pipeline = await this.findPipelineById(id);
    if (pipeline.isDefault) {
      throw new ConflictException(
        'Make another pipeline the default before archiving this one.',
      );
    }

    const inUse = await this.countDealsReferencing('pipelineId', id);
    if (inUse > 0) {
      throw new ConflictException(
        `Pipeline "${pipeline.name}" still holds deals. Move them to another pipeline first.`,
      );
    }

    await this.pipelineModel
      .updateOne(
        { _id: id, tenantId: this.tenantId },
        { $set: { isArchived: true } },
      )
      .exec();
  }

  // Placement

  /**
   * Resolve where a deal belongs, validating that the stage lives in the pipeline.
   *
   * The single entry point for both create and stage-move. Without it a deal could
   * be filed under pipeline A while sitting in a stage of pipeline B — a state the
   * board cannot render and no report can group.
   */
  async resolvePlacement(input: {
    pipelineId?: string;
    stageId?: string;
  }): Promise<DealPlacement> {
    const pipelineId =
      input.pipelineId ?? (await this.requireDefaultPipelineId());

    const stage = input.stageId
      ? await this.stageModel
          .findOne({ _id: input.stageId, tenantId: this.tenantId })
          .lean()
          .exec()
      : await this.stageModel
          .findOne({ tenantId: this.tenantId, pipelineId })
          .sort({ isDefault: -1, sortOrder: 1 })
          .lean()
          .exec();

    if (!stage) {
      throw new BadRequestException(
        input.stageId
          ? `Stage ${input.stageId} does not exist in this workspace.`
          : 'This pipeline has no stages yet. Add one in Settings → Deals.',
      );
    }

    if (String(stage.pipelineId) !== String(pipelineId)) {
      throw new BadRequestException(
        `Stage "${stage.label}" belongs to a different pipeline.`,
      );
    }

    return {
      pipelineId: String(pipelineId),
      stageId: String(stage._id),
      probability: stage.probability ?? 0,
      isWon: Boolean(stage.isWon),
      isLost: Boolean(stage.isLost),
    };
  }

  /**
   * Describe a stage without refusing when it is gone.
   *
   * The close-state guard has to ask "was the stage it came from a winning one",
   * and a stage deleted out from under a historical deal must degrade to "unknown"
   * rather than fail the write.
   */
  async describeStage(stageId: string): Promise<DealPlacement | null> {
    const stage = await this.stageModel
      .findOne({ _id: stageId, tenantId: this.tenantId })
      .lean()
      .exec();
    if (!stage) return null;
    return {
      pipelineId: String(stage.pipelineId),
      stageId: String(stage._id),
      probability: stage.probability ?? 0,
      isWon: Boolean(stage.isWon),
      isLost: Boolean(stage.isLost),
    };
  }

  private async requireDefaultPipelineId(): Promise<string> {
    const pipeline = await this.pipelineModel
      .findOne({ tenantId: this.tenantId, isArchived: false })
      .sort({ isDefault: -1, sortOrder: 1 })
      .select('_id')
      .lean()
      .exec();
    if (!pipeline) {
      throw new BadRequestException(
        'This workspace has no deal pipeline yet. Create one in Settings → Deals.',
      );
    }
    return String(pipeline._id);
  }

  private translateDuplicateKey(error: unknown, apiName: string): unknown {
    if ((error as { code?: number })?.code === 11000) {
      return new ConflictException(
        `A stage with the machine name "${apiName}" already exists in this pipeline.`,
      );
    }
    return error;
  }
}
