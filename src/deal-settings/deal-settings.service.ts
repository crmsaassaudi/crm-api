import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
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
    return this.cls.get('tenantId');
  }

  // ── Stages ─────────────────────────────────────────────────────────────
  async findAllStages(pipelineId?: string) {
    const filter: any = { tenantId: this.tenantId };
    if (pipelineId) filter.pipelineId = pipelineId;
    return this.stageModel.find(filter).sort({ sortOrder: 1 }).exec();
  }

  async createStage(data: Partial<DealStageSchemaClass>) {
    return this.stageModel.create({ ...data, tenantId: this.tenantId });
  }

  async updateStage(id: string, data: Partial<DealStageSchemaClass>) {
    return this.stageModel
      .findOneAndUpdate({ _id: id, tenantId: this.tenantId }, data, {
        new: true,
      })
      .exec();
  }

  async deleteStage(id: string): Promise<void> {
    await this.stageModel
      .deleteOne({ _id: id, tenantId: this.tenantId })
      .exec();
  }

  async findStageById(id: string) {
    return this.stageModel.findOne({ _id: id, tenantId: this.tenantId }).exec();
  }

  // ── Sources ────────────────────────────────────────────────────────────
  async findAllSources() {
    return this.sourceModel
      .find({ tenantId: this.tenantId })
      .sort({ sortOrder: 1 })
      .exec();
  }

  async createSource(data: Partial<DealSourceSchemaClass>) {
    return this.sourceModel.create({ ...data, tenantId: this.tenantId });
  }

  async updateSource(id: string, data: Partial<DealSourceSchemaClass>) {
    return this.sourceModel
      .findOneAndUpdate({ _id: id, tenantId: this.tenantId }, data, {
        new: true,
      })
      .exec();
  }

  async deleteSource(id: string): Promise<void> {
    await this.sourceModel
      .deleteOne({ _id: id, tenantId: this.tenantId })
      .exec();
  }

  // ── Pipelines ───────────────────────────────────────────────────────────

  async findAllPipelines() {
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

  async createPipeline(data: {
    name: string;
    description?: string;
    color?: string;
    isDefault?: boolean;
    sortOrder?: number;
  }) {
    const tenantId = this.tenantId;

    // Ensure uniqueness: only one default pipeline per tenant
    if (data.isDefault) {
      await this.pipelineModel.updateMany(
        { tenantId, isDefault: true },
        { $set: { isDefault: false } },
      );
    }

    // If this is the first pipeline, make it default
    const count = await this.pipelineModel.countDocuments({ tenantId });
    const isDefault = data.isDefault ?? count === 0;

    return this.pipelineModel.create({
      ...data,
      tenantId,
      isDefault,
    });
  }

  async updatePipeline(
    id: string,
    data: {
      name?: string;
      description?: string;
      color?: string;
      sortOrder?: number;
      isDefault?: boolean;
    },
  ) {
    const tenantId = this.tenantId;

    // If setting as default, demote others first
    if (data.isDefault === true) {
      await this.pipelineModel.updateMany(
        { tenantId, isDefault: true, _id: { $ne: id } },
        { $set: { isDefault: false } },
      );
    }

    const updated = await this.pipelineModel
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .exec();

    if (!updated) throw new NotFoundException(`Pipeline ${id} not found`);
    return updated;
  }

  async archivePipeline(id: string): Promise<void> {
    const result = await this.pipelineModel
      .updateOne(
        { _id: id, tenantId: this.tenantId },
        { $set: { isArchived: true, isDefault: false } },
      )
      .exec();
    if (result.matchedCount === 0)
      throw new NotFoundException(`Pipeline ${id} not found`);
  }

  async getDefaultPipelineId(): Promise<string | null> {
    const pipeline = await this.pipelineModel
      .findOne({ tenantId: this.tenantId, isDefault: true, isArchived: false })
      .select('_id')
      .lean()
      .exec();
    return pipeline ? String(pipeline._id) : null;
  }
}
