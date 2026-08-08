import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import {
  AutomationWorkflowSchemaClass,
  WorkflowStatus,
} from '../entities/automation-workflow.schema';
import { escapeRegex } from '../../../../../utils/escape-regex';

@Injectable()
export class AutomationWorkflowRepository {
  constructor(
    @InjectModel(AutomationWorkflowSchemaClass.name)
    private readonly model: Model<AutomationWorkflowSchemaClass>,
  ) {}

  // Queries

  /**
   * The workflow list, optionally narrowed by status and free text.
   *
   * A case-insensitive `$regex` is the right tool here and the wrong one on
   * deals or tickets: this collection holds a tenant's automation *settings*, so
   * it is bounded by how many workflows a team writes, not by business volume.
   * The scan is over tens of documents behind the `tenantId` index and will stay
   * that way — which is why it does not need `searchKeys`.
   */
  async findAll(
    tenantId: string,
    filters: { status?: WorkflowStatus; search?: string } = {},
  ) {
    const query: FilterQuery<AutomationWorkflowSchemaClass> = { tenantId };
    if (filters.status) query.status = filters.status;

    const term = filters.search?.trim();
    if (term) {
      const expression = { $regex: escapeRegex(term), $options: 'i' };
      query.$or = [{ name: expression }, { description: expression }];
    }

    return this.model.find(query).sort({ updatedAt: -1 }).lean().exec();
  }

  async findById(tenantId: string, id: string) {
    return this.model.findOne({ _id: id, tenantId }).lean().exec();
  }

  /**
   * Find all active workflows matching a specific PUBLISHED trigger event + object.
   * Used by the Event Listener to determine which workflows to evaluate.
   * Queries publishedTriggerConfig (immutable snapshot) — NOT draft triggerConfig.
   */
  async findActiveByTrigger(
    tenantId: string,
    event: 'record_created' | 'field_updated',
    object: string,
  ) {
    // Mongoose strips `undefined` values out of a filter, so a falsy event or
    // object would silently widen this to "every active workflow in the tenant"
    // and execute all of them. Fail loudly instead — a caller with no trigger
    // to match has a bug, not a query.
    if (!tenantId || !event || !object) {
      throw new Error(
        `findActiveByTrigger requires tenantId, event and object ` +
          `(got tenantId=${tenantId}, event=${event}, object=${object})`,
      );
    }

    return this.model
      .find({
        tenantId,
        status: 'active',
        'publishedTriggerConfig.event': event,
        'publishedTriggerConfig.object': object,
      })
      .lean()
      .exec();
  }

  // Mutations

  async create(data: Partial<AutomationWorkflowSchemaClass>) {
    const doc = await this.model.create(data);
    return doc.toObject();
  }

  /**
   * `runValidators` is on deliberately.
   *
   * Mongoose skips validators on `findOneAndUpdate` by default, so schema enums
   * would apply on create and not on update. That asymmetry is worse than no
   * validation: it lets an update write a state the same document could not have
   * been created in, and hides a stale enum until someone tries to create the
   * value it is missing.
   */
  async update(
    tenantId: string,
    id: string,
    data: Partial<AutomationWorkflowSchemaClass>,
  ) {
    return this.model
      .findOneAndUpdate(
        { _id: id, tenantId },
        { $set: data },
        { new: true, runValidators: true },
      )
      .lean()
      .exec();
  }

  async updateStatus(tenantId: string, id: string, status: WorkflowStatus) {
    return this.model
      .findOneAndUpdate(
        { _id: id, tenantId },
        { $set: { status } },
        { new: true, runValidators: true },
      )
      .lean()
      .exec();
  }

  async incrementExecutionCount(tenantId: string, id: string): Promise<void> {
    await this.model
      .updateOne(
        { _id: id, tenantId },
        {
          $inc: { executionCount: 1 },
          $set: { lastExecutedAt: new Date() },
        },
      )
      .exec();
  }

  /**
   * Publish a workflow: atomically copy draft → published snapshot.
   * Increments the version counter and sets publishedAt.
   * Does NOT change status (Publish is decoupled from Activate).
   */
  async publish(tenantId: string, id: string) {
    const workflow = await this.model
      .findOne({ _id: id, tenantId })
      .lean()
      .exec();
    if (!workflow) return null;

    return this.model
      .findOneAndUpdate(
        { _id: id, tenantId },
        {
          $set: {
            publishedNodes: workflow.nodes,
            publishedEdges: workflow.edges,
            publishedTriggerConfig: workflow.triggerConfig,
            publishedAt: new Date(),
          },
          $inc: { version: 1 },
        },
        { new: true, runValidators: true },
      )
      .lean()
      .exec();
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, tenantId }).exec();
    return result.deletedCount > 0;
  }

  /**
   * Deep-clone a workflow for the Duplicate feature.
   * Returns the new document with fresh ID, draft status, and reset counters.
   */
  async duplicate(tenantId: string, id: string, userId: string) {
    const source = await this.model
      .findOne({ _id: id, tenantId })
      .lean()
      .exec();
    if (!source) return null;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id, __v, createdAt, updatedAt, ...rest } = source as any;

    const clone = await this.model.create({
      ...rest,
      name: `${rest.name} (Copy)`,
      status: 'draft',
      executionCount: 0,
      lastExecutedAt: null,
      // Reset published state — clones start as pure drafts
      publishedNodes: [],
      publishedEdges: [],
      publishedTriggerConfig: null,
      publishedAt: null,
      version: 0,
      createdBy: userId,
      updatedBy: userId,
    });

    return clone.toObject();
  }

  /**
   * Replace configId in all action nodes across active + draft workflows.
   *
   * Used by the Channel Config migration flow: when admin deletes a config,
   * all workflow nodes that reference the old configId are updated to point
   * to the new fallback configId.
   *
   * Updates both:
   *   - nodes[].config.configId (draft)
   *   - publishedNodes[].config.configId (published snapshot)
   *
   * Uses MongoDB session (transaction) for atomicity.
   * Returns count of updated workflow documents.
   */
  async replaceConfigIdInNodes(
    tenantId: string,
    sourceConfigId: string,
    targetConfigId: string,
  ): Promise<number> {
    const session = await this.model.startSession();
    let updatedCount = 0;

    try {
      await session.withTransaction(async () => {
        const workflows = await this.model
          .find({
            tenantId,
            $or: [
              { 'nodes.config.configId': sourceConfigId },
              { 'publishedNodes.config.configId': sourceConfigId },
            ],
          })
          .session(session)
          .exec();

        for (const workflow of workflows) {
          const modified = this.patchNodesConfigId(
            workflow,
            sourceConfigId,
            targetConfigId,
          );
          if (modified) {
            workflow.markModified('nodes');
            workflow.markModified('publishedNodes');
            await workflow.save({ session });
            updatedCount++;
          }
        }
      });
    } finally {
      await session.endSession();
    }

    return updatedCount;
  }

  /**
   * Mutate a single workflow document, replacing sourceConfigId with
   * targetConfigId in both draft nodes and published-snapshot nodes.
   *
   * Returns true when at least one node was patched so the caller knows
   * whether to save the document.
   */
  private patchNodesConfigId(
    workflow: AutomationWorkflowSchemaClass,
    sourceConfigId: string,
    targetConfigId: string,
  ): boolean {
    let modified = false;

    if (workflow.nodes && Array.isArray(workflow.nodes)) {
      for (const node of workflow.nodes as any[]) {
        if (node.config?.configId === sourceConfigId) {
          node.config.configId = targetConfigId;
          modified = true;
        }
      }
    }

    if (workflow.publishedNodes && Array.isArray(workflow.publishedNodes)) {
      for (const node of workflow.publishedNodes as any[]) {
        if (node.config?.configId === sourceConfigId) {
          node.config.configId = targetConfigId;
          modified = true;
        }
      }
    }

    return modified;
  }
}
