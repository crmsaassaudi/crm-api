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
   * Find all active workflows matching a specific trigger event + object.
   * Used by the Event Listener to determine which workflows to evaluate.
   */
  async findActiveByTrigger(
    tenantId: string,
    event: 'record_created' | 'field_updated',
    object: 'Lead' | 'Contact' | 'Ticket',
  ) {
    return this.model
      .find({
        tenantId,
        status: 'active',
        'triggerConfig.event': event,
        'triggerConfig.object': object,
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
      createdBy: userId,
      updatedBy: userId,
    });

    return clone.toObject();
  }
}
