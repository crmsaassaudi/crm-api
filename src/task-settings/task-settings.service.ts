import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { TaskSchemaClass } from '../tasks/infrastructure/persistence/document/entities/task.schema';
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
    // Needed to answer "is anything still using this?" before a delete.
    @InjectModel(TaskSchemaClass.name)
    private readonly taskModel: Model<any>,
    private readonly cls: ClsService,
  ) {}

  private get tenantId(): string {
    return this.cls.get('tenantId');
  }

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
    await this.assertNotInUse('statusId', id, 'Trạng thái');
    await this.statusModel
      .deleteOne({ _id: id, tenantId: this.tenantId })
      .exec();
  }

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
    await this.assertNotInUse('categoryId', id, 'Nhóm công việc');
    await this.categoryModel
      .deleteOne({ _id: id, tenantId: this.tenantId })
      .exec();
  }

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
    await this.assertNotInUse('sourceId', id, 'Nguồn công việc');
    await this.sourceModel
      .deleteOne({ _id: id, tenantId: this.tenantId })
      .exec();
  }

  /**
   * Refuse to delete a setting that tasks still point at.
   *
   * These three deletes were unconditional hard deletes with no referential check
   * at all. Removing a status in use left every task that referenced it with a
   * `statusId` pointing at nothing: `populate('taskStatus')` returned null so the
   * Kanban board lost a column and those tasks rendered with no status, and the
   * `?status=` filter — which resolves apiNames to ids — matched nothing, so the
   * list came back empty. All of it silent, and with no way back, because there is
   * no recycle bin for settings.
   *
   * A count, not a cascade: silently reassigning other people's tasks to a
   * different status is a bigger surprise than a refusal. The message names the
   * number so the admin knows the size of the cleanup.
   */
  private async assertNotInUse(
    field: 'statusId' | 'categoryId' | 'sourceId',
    id: string,
    label: string,
  ): Promise<void> {
    // Soft-deleted tasks count. They are restorable, and restoring one whose
    // status had been deleted in the meantime would reintroduce the dangling
    // reference this check exists to prevent.
    const inUse = await this.taskModel
      .countDocuments({ [field]: id, tenantId: this.tenantId })
      .limit(1)
      .exec();

    if (inUse > 0) {
      const total = await this.taskModel
        .countDocuments({ [field]: id, tenantId: this.tenantId })
        .exec();
      throw new ConflictException(
        `${label} đang được ${total} task sử dụng. Hãy chuyển các task đó sang giá trị khác trước khi xoá.`,
      );
    }
  }
}
