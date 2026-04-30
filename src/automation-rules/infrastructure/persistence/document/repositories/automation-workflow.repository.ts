import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AutomationWorkflowSchemaClass,
  WorkflowStatus,
} from '../entities/automation-workflow.schema';

@Injectable()
export class AutomationWorkflowRepository {
  constructor(
    @InjectModel(AutomationWorkflowSchemaClass.name)
    private readonly model: Model<AutomationWorkflowSchemaClass>,
  ) {}

  // ── Queries ────────────────────────────────────────────────────────────

  async findAll(tenantId: string) {
    return this.model.find({ tenantId }).sort({ updatedAt: -1 }).lean().exec();
  }

  async findById(tenantId: string, id: string) {
    return this.model.findOne({ _id: id, tenantId }).lean().exec();
  }

  async findByStatus(tenantId: string, status: WorkflowStatus) {
    return this.model
      .find({ tenantId, status })
      .sort({ updatedAt: -1 })
      .lean()
      .exec();
  }

  /**
   * Find all active workflows matching a specific PUBLISHED trigger event + object.
   * Used by the Event Listener to determine which workflows to evaluate.
   * Queries publishedTriggerConfig (immutable snapshot) — NOT draft triggerConfig.
   */
  async findActiveByTrigger(
    tenantId: string,
    event: 'record_created' | 'field_updated',
    object: 'Lead' | 'Contact' | 'Ticket' | 'Deal' | 'Account' | 'Task',
  ) {
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

  // ── Mutations ──────────────────────────────────────────────────────────

  async create(data: Partial<AutomationWorkflowSchemaClass>) {
    const doc = await this.model.create(data);
    return doc.toObject();
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<AutomationWorkflowSchemaClass>,
  ) {
    return this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .lean()
      .exec();
  }

  async updateStatus(tenantId: string, id: string, status: WorkflowStatus) {
    return this.model
      .findOneAndUpdate(
        { _id: id, tenantId },
        { $set: { status } },
        { new: true },
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
        { new: true },
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
}
