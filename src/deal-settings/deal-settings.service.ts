import { Injectable } from '@nestjs/common';
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

@Injectable()
export class DealSettingsService {
  constructor(
    @InjectModel(DealStageSchemaClass.name)
    private readonly stageModel: Model<DealStageDocument>,
    @InjectModel(DealSourceSchemaClass.name)
    private readonly sourceModel: Model<DealSourceDocument>,
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
}
