import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import { TaskSchemaClass, TaskSchemaDocument } from '../entities/task.schema';
import { TaskStatusSchemaClass } from '../../../../../task-settings/entities/task-status.schema';
import { Task } from '../../../../domain/task';
import { TaskMapper } from '../mappers/task.mapper';
import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';
import { IPaginationOptions } from '../../../../../utils/types/pagination-options';
import { PaginationResponseDto } from '../../../../../utils/dto/pagination-response.dto';
import { pagination } from '../../../../../utils/pagination';
import { escapeRegex } from '../../../../../utils/escape-regex';

@Injectable()
export class TaskRepository extends BaseDocumentRepository<
  TaskSchemaDocument,
  Task
> {
  constructor(
    @InjectModel(TaskSchemaClass.name)
    taskModel: Model<TaskSchemaDocument>,
    @InjectModel(TaskStatusSchemaClass.name)
    private readonly statusModel: Model<any>,
    cls: ClsService,
  ) {
    super(taskModel, cls);
  }

  protected mapToDomain(doc: TaskSchemaClass): Task {
    return TaskMapper.toDomain(doc);
  }

  protected toPersistence(domain: Task): TaskSchemaClass {
    return TaskMapper.toPersistence(domain);
  }

  async findManyWithPagination({
    filterOptions,
    paginationOptions,
  }: {
    filterOptions?: any;
    paginationOptions: IPaginationOptions;
  }): Promise<PaginationResponseDto<Task>> {
    // MED-08: Exclude soft-deleted tasks from list queries
    const where: FilterQuery<TaskSchemaClass> = {
      deletedAt: { $exists: false },
    };

    if (filterOptions?.search) {
      // MED-07: Escape user input to prevent ReDoS
      const searchExpr = {
        $regex: escapeRegex(filterOptions.search),
        $options: 'i',
      };
      where.$or = [{ title: searchExpr }, { description: searchExpr }];
    }

    if (filterOptions?.status) {
      // Status param can be comma-separated apiNames (e.g. 'pending,in_progress')
      const statusNames = String(filterOptions.status)
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);

      // Resolve apiNames to ObjectIds
      const statusDocs = await this.statusModel
        .find({ apiName: { $in: statusNames } })
        .select('_id')
        .lean()
        .exec();

      const statusIds = statusDocs.map((d: any) => d._id);
      if (statusIds.length > 0) {
        where.statusId =
          statusIds.length === 1 ? statusIds[0] : { $in: statusIds };
      } else {
        // No matching statuses found — return empty result
        where.statusId = { $in: [] };
      }
    }

    if (filterOptions?.priority) {
      where.priority = filterOptions.priority;
    }

    if (filterOptions?.contactId) {
      where.$and = [
        ...(where.$and || []),
        { 'relatedTo.type': 'Contact' },
        {
          $or: [
            { 'relatedTo._id': filterOptions.contactId },
            { 'relatedTo.id': filterOptions.contactId },
          ],
        },
      ];
    }

    const scopedWhere = this.applyTenantFilter(where);

    const [docs, totalItems] = await Promise.all([
      this.model
        .find(scopedWhere)
        .sort({ dueDate: 1, createdAt: -1 })
        .skip((paginationOptions.page - 1) * paginationOptions.limit)
        .limit(paginationOptions.limit)
        .populate('assignedTo', 'firstName lastName photo email')
        .populate('owner', 'firstName lastName photo email')
        .populate('taskStatus')
        .populate('taskCategory')
        .populate('taskSource')
        .exec(),
      this.model.countDocuments(scopedWhere).exec(),
    ]);

    return pagination(
      docs.map((doc) => this.mapToDomain(doc)),
      totalItems,
      paginationOptions,
    );
  }

  async findOne(filter: FilterQuery<TaskSchemaClass>): Promise<Task | null> {
    const scopedFilter = this.applyTenantFilter(filter);
    const doc = await this.model
      .findOne(scopedFilter)
      .populate('assignedTo', 'firstName lastName photo email')
      .populate('owner', 'firstName lastName photo email')
      .populate('taskStatus')
      .populate('taskCategory')
      .populate('taskSource')
      .exec();
    return doc ? this.mapToDomain(doc) : null;
  }
}
