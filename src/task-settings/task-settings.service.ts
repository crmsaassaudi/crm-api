import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import {
  TaskStatusSchemaClass,
  TaskStatusDocument,
} from './entities/task-status.schema';
import {
  TaskCategorySchemaClass,
  TaskCategoryDocument,
} from './entities/task-category.schema';
import {
  TaskSourceSchemaClass,
  TaskSourceDocument,
} from './entities/task-source.schema';

@Injectable()
export class TaskSettingsService {
  constructor(
    @InjectModel(TaskStatusSchemaClass.name)
    private readonly statusModel: Model<TaskStatusDocument>,
    @InjectModel(TaskCategorySchemaClass.name)
    private readonly categoryModel: Model<TaskCategoryDocument>,
    @InjectModel(TaskSourceSchemaClass.name)
    private readonly sourceModel: Model<TaskSourceDocument>,
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

  async createStatus(data: Partial<TaskStatusSchemaClass>) {
    return this.statusModel.create({ ...data, tenantId: this.tenantId });
  }

  async updateStatus(id: string, data: Partial<TaskStatusSchemaClass>) {
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

  // ── Categories ─────────────────────────────────────────────────────────
  async findAllCategories() {
    return this.categoryModel
      .find({ tenantId: this.tenantId })
      .sort({ sortOrder: 1 })
      .exec();
  }

  async createCategory(data: Partial<TaskCategorySchemaClass>) {
    return this.categoryModel.create({ ...data, tenantId: this.tenantId });
  }

  async updateCategory(id: string, data: Partial<TaskCategorySchemaClass>) {
    return this.categoryModel
      .findOneAndUpdate({ _id: id, tenantId: this.tenantId }, data, {
        new: true,
      })
      .exec();
  }

  async deleteCategory(id: string): Promise<void> {
    await this.categoryModel
      .deleteOne({ _id: id, tenantId: this.tenantId })
      .exec();
  }

  // ── Sources ────────────────────────────────────────────────────────────
  async findAllSources() {
    return this.sourceModel
      .find({ tenantId: this.tenantId })
      .sort({ sortOrder: 1 })
      .exec();
  }

  async createSource(data: Partial<TaskSourceSchemaClass>) {
    return this.sourceModel.create({ ...data, tenantId: this.tenantId });
  }

  async updateSource(id: string, data: Partial<TaskSourceSchemaClass>) {
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
