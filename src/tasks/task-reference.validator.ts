import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TaskStatusSchemaClass } from '../task-settings/entities/task-status.schema';
import { TaskCategorySchemaClass } from '../task-settings/entities/task-category.schema';
import { TaskSourceSchemaClass } from '../task-settings/entities/task-source.schema';
import { UserSchemaClass } from '../users/infrastructure/persistence/document/entities/user.schema';
import { TaskStatusFacts } from './domain/task-lifecycle';

/** What the caller may set that points at another document. */
export interface TaskReferences {
  ownerId?: string | null;
  statusId?: string | null;
  categoryId?: string | null;
  sourceId?: string | null;
}

export interface ResolvedReferences {
  /** Terminality of every status in the tenant, for the lifecycle rules. */
  statuses: ReadonlyMap<string, TaskStatusFacts>;
}

/**
 * Confirms that every id a task points at exists inside the caller's tenant.
 *
 * The DTO can only check shape. It cannot answer the question that actually
 * matters — "is this a real user in MY tenant?" — and while nothing did, three
 * things followed from an unvalidated `ownerId`:
 *
 *  1. A dangling owner: `populate('owner')` returned null and the UI showed a
 *     task with nobody responsible for it.
 *  2. A record invisible to its own organisation. Data visibility filters on
 *     `ownerId: {$in: visibleOwnerIds}`, so setting the owner to any ObjectId
 *     outside the tenant matched no scope at all and only an admin could still
 *     see the task. One PATCH was enough for a user to hide their own work from
 *     every level of management — and `includeUnownedInScope` had already closed
 *     the `ownerId: null` version of this hole, which is what made the id-shaped
 *     version worth closing too.
 *  3. A 500 instead of a 422, because a non-ObjectId string reached Mongoose and
 *     surfaced as a CastError.
 *
 * Every lookup below is tenant-scoped by `tenantFilterPlugin`, so "exists" here
 * always means "exists in this tenant" — a foreign id is indistinguishable from
 * a nonexistent one, which is the correct answer to give.
 */
@Injectable()
export class TaskReferenceValidator {
  constructor(
    @InjectModel(TaskStatusSchemaClass.name)
    private readonly statusModel: Model<any>,
    @InjectModel(TaskCategorySchemaClass.name)
    private readonly categoryModel: Model<any>,
    @InjectModel(TaskSourceSchemaClass.name)
    private readonly sourceModel: Model<any>,
    @InjectModel(UserSchemaClass.name)
    private readonly userModel: Model<any>,
  ) {}

  /**
   * Validate the references in `input` and return the facts the lifecycle rules
   * need.
   *
   * Always loads the tenant's statuses, even when the payload sets no status:
   * `applyLifecycle` has to know whether the task's *current* status is terminal
   * in order to decide about `completedAt`.
   */
  async resolve(input: TaskReferences): Promise<ResolvedReferences> {
    const [statuses] = await Promise.all([
      this.loadStatusFacts(),
      this.assertOwnerExists(input.ownerId),
      this.assertSettingExists(
        this.categoryModel,
        input.categoryId,
        'categoryId',
        'Nhóm công việc',
      ),
      this.assertSettingExists(
        this.sourceModel,
        input.sourceId,
        'sourceId',
        'Nguồn công việc',
      ),
    ]);

    // statusId is checked against the same map the lifecycle rules use, so the
    // two can never disagree about which statuses exist.
    if (input.statusId && !statuses.has(String(input.statusId))) {
      throw this.reject('statusId', 'Trạng thái không tồn tại trong tenant.');
    }

    return { statuses };
  }

  private async loadStatusFacts(): Promise<
    ReadonlyMap<string, TaskStatusFacts>
  > {
    const docs = await this.statusModel
      .find({})
      .select({ _id: 1, isTerminal: 1 })
      .lean()
      .exec();
    return new Map(
      docs.map((doc: any) => [
        String(doc._id),
        { isTerminal: doc.isTerminal === true },
      ]),
    );
  }

  /**
   * The owner must be a real, non-deleted, non-inactive member of the tenant.
   *
   * Inactive is refused as well as missing: assigning work to a deactivated
   * account is indistinguishable from losing it, since nobody will ever open
   * that queue.
   */
  private async assertOwnerExists(ownerId?: string | null): Promise<void> {
    if (!ownerId) return;
    if (!Types.ObjectId.isValid(ownerId)) {
      throw this.reject(
        'ownerId',
        'ownerId không phải là một ObjectId hợp lệ.',
      );
    }

    const user = (await this.userModel
      .findOne({ _id: ownerId, deletedAt: null })
      .select({ _id: 1, status: 1 })
      .lean()
      .exec()) as { _id: unknown; status?: string | null } | null;

    if (!user) {
      throw this.reject(
        'ownerId',
        'Người phụ trách không tồn tại trong tenant này.',
      );
    }
    if (user.status === 'inactive') {
      throw this.reject(
        'ownerId',
        'Không thể giao việc cho người dùng đã bị vô hiệu hoá.',
      );
    }
  }

  private async assertSettingExists(
    model: Model<any>,
    id: string | null | undefined,
    field: string,
    label: string,
  ): Promise<void> {
    if (!id) return;
    if (!Types.ObjectId.isValid(id)) {
      throw this.reject(field, `${field} không phải là một ObjectId hợp lệ.`);
    }
    const exists = await model.exists({ _id: id });
    if (!exists) {
      throw this.reject(field, `${label} không tồn tại trong tenant này.`);
    }
  }

  /** Shaped like the global ValidationPipe's output so clients parse one format. */
  private reject(field: string, message: string): UnprocessableEntityException {
    return new UnprocessableEntityException({
      status: 422,
      errors: { [field]: message },
    });
  }
}
