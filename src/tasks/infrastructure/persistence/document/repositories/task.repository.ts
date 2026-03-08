import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import { TaskSchemaClass, TaskSchemaDocument } from '../entities/task.schema';
import { Task } from '../../../../domain/task';
import { TaskMapper } from '../mappers/task.mapper';
import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';
import { IPaginationOptions } from '../../../../../utils/types/pagination-options';
import { PaginationResponseDto } from '../../../../../utils/dto/pagination-response.dto';
import { pagination } from '../../../../../utils/pagination';

@Injectable()
export class TaskRepository extends BaseDocumentRepository<
  TaskSchemaDocument,
  Task
> {
  constructor(
    @InjectModel(TaskSchemaClass.name)
    taskModel: Model<TaskSchemaDocument>,
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
    const where: FilterQuery<TaskSchemaClass> = {};

    if (filterOptions?.search) {
      const searchExpr = { $regex: filterOptions.search, $options: 'i' };
      where.$or = [{ title: searchExpr }, { description: searchExpr }];
    }

    if (filterOptions?.status) {
      where.status = filterOptions.status;
    }

    if (filterOptions?.priority) {
      where.priority = filterOptions.priority;
    }

    const scopedWhere = this.applyTenantFilter(where);

    const [docs, totalItems] = await Promise.all([
      this.model
        .find(scopedWhere)
        .sort({ dueDate: 1, createdAt: -1 })
        .skip((paginationOptions.page - 1) * paginationOptions.limit)
        .limit(paginationOptions.limit)
        .populate('assignedTo', 'firstName lastName photo email')
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
      .exec();
    return doc ? this.mapToDomain(doc) : null;
  }
}
