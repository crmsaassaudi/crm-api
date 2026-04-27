import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import {
  ContactStatusSchemaClass,
  ContactStatusDocument,
} from './entities/contact-status.schema';
import {
  ContactSourceSchemaClass,
  ContactSourceDocument,
} from './entities/contact-source.schema';
import {
  ContactLifecycleStageSchemaClass,
  ContactLifecycleStageDocument,
} from './entities/contact-lifecycle-stage.schema';

@Injectable()
export class ContactSettingsService {
  constructor(
    @InjectModel(ContactStatusSchemaClass.name)
    private readonly statusModel: Model<ContactStatusDocument>,
    @InjectModel(ContactSourceSchemaClass.name)
    private readonly sourceModel: Model<ContactSourceDocument>,
    @InjectModel(ContactLifecycleStageSchemaClass.name)
    private readonly lifecycleStageModel: Model<ContactLifecycleStageDocument>,
    private readonly cls: ClsService,
  ) {}

  private get tenantId(): string {
    return this.cls.get('tenantId');
  }

  // ── Statuses ───────────────────────────────────────────────────────────
  async findAllStatuses() {
    return this.statusModel
      .find({ tenantId: this.tenantId })
      .sort({ sortOrder: 1 })
      .exec();
  }

  async createStatus(data: Partial<ContactStatusSchemaClass>) {
    return this.statusModel.create({ ...data, tenantId: this.tenantId });
  }

  async updateStatus(id: string, data: Partial<ContactStatusSchemaClass>) {
    return this.statusModel
      .findOneAndUpdate({ _id: id, tenantId: this.tenantId }, data, {
        new: true,
      })
      .exec();
  }

  async deleteStatus(id: string): Promise<void> {
    await this.statusModel
      .deleteOne({ _id: id, tenantId: this.tenantId })
      .exec();
  }

  async findStatusById(id: string) {
    return this.statusModel
      .findOne({ _id: id, tenantId: this.tenantId })
      .exec();
  }

  // ── Sources ────────────────────────────────────────────────────────────
  async findAllSources() {
    return this.sourceModel
      .find({ tenantId: this.tenantId })
      .sort({ sortOrder: 1 })
      .exec();
  }

  async createSource(data: Partial<ContactSourceSchemaClass>) {
    return this.sourceModel.create({ ...data, tenantId: this.tenantId });
  }

  async updateSource(id: string, data: Partial<ContactSourceSchemaClass>) {
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

  // ── Lifecycle Stages ───────────────────────────────────────────────────
  async findAllLifecycleStages() {
    return this.lifecycleStageModel
      .find({ tenantId: this.tenantId })
      .sort({ sortOrder: 1 })
      .exec();
  }

  async createLifecycleStage(data: Partial<ContactLifecycleStageSchemaClass>) {
    return this.lifecycleStageModel.create({
      ...data,
      tenantId: this.tenantId,
    });
  }

  async updateLifecycleStage(
    id: string,
    data: Partial<ContactLifecycleStageSchemaClass>,
  ) {
    return this.lifecycleStageModel
      .findOneAndUpdate({ _id: id, tenantId: this.tenantId }, data, {
        new: true,
      })
      .exec();
  }

  async deleteLifecycleStage(id: string): Promise<void> {
    await this.lifecycleStageModel
      .deleteOne({ _id: id, tenantId: this.tenantId })
      .exec();
  }
}
