import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AutomationExecutionLogSchemaClass,
  ExecutionStatus,
  ExecutionStep,
} from '../entities/automation-execution-log.schema';

const LOG_RETENTION_DAYS = 30;

@Injectable()
export class AutomationExecutionLogRepository {
  constructor(
    @InjectModel(AutomationExecutionLogSchemaClass.name)
    private readonly model: Model<AutomationExecutionLogSchemaClass>,
  ) {}

  // ── Queries ────────────────────────────────────────────────────────────

  /**
   * Find logs for a specific workflow, sorted newest first.
   * Supports status filter and cursor-based pagination.
   */
  async findByWorkflow(
    tenantId: string,
    workflowId: string,
    options?: {
      status?: ExecutionStatus;
      limit?: number;
      beforeId?: string;
    },
  ) {
    const filter: Record<string, any> = { tenantId, workflowId };

    if (options?.status) {
      filter.status = options.status;
    }
    if (options?.beforeId) {
      filter._id = { $lt: options.beforeId };
    }

    return this.model
      .find(filter)
      .sort({ startedAt: -1 })
      .limit(options?.limit ?? 20)
      .lean()
      .exec();
  }

  /**
   * Find all logs for a specific record across all workflows.
   */
  async findByRecord(tenantId: string, recordId: string) {
    return this.model
      .find({ tenantId, recordId })
      .sort({ startedAt: -1 })
      .limit(50)
      .lean()
      .exec();
  }

  async findById(tenantId: string, id: string) {
    return this.model.findOne({ _id: id, tenantId }).lean().exec();
  }

  /**
   * Find logs with arbitrary filter, pagination, and total count.
   * Used by the Execution Log Controller for dashboards.
   */
  async findWithPagination(
    filter: Record<string, any>,
    skip: number,
    limit: number,
  ): Promise<[any[], number]> {
    const [data, total] = await Promise.all([
      this.model
        .find(filter)
        .sort({ startedAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-steps') // Exclude steps for list view performance
        .lean()
        .exec(),
      this.model.countDocuments(filter).exec(),
    ]);
    return [data, total];
  }

  /**
   * Get execution log detail with full step trace for debugging.
   */
  async findByIdWithSteps(tenantId: string, id: string) {
    return this.model.findOne({ _id: id, tenantId }).lean().exec();
  }

  /**
   * Aggregate execution stats for a specific workflow.
   * Returns counts per status and average duration.
   */
  async getWorkflowStats(tenantId: string, workflowId: string) {
    const [statusCounts, avgDuration] = await Promise.all([
      this.model.aggregate([
        { $match: { tenantId, workflowId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      this.model.aggregate([
        { $match: { tenantId, workflowId, status: 'success' } },
        {
          $group: {
            _id: null,
            avgDuration: { $avg: '$duration' },
            total: { $sum: 1 },
          },
        },
      ]),
    ]);

    const stats: Record<string, number> = {
      total: 0,
      success: 0,
      failed: 0,
      running: 0,
      loop_blocked: 0,
      skipped_run_once: 0,
    };

    for (const s of statusCounts) {
      stats[s._id] = s.count;
      stats.total += s.count;
    }

    return {
      ...stats,
      avgDurationMs: avgDuration[0]?.avgDuration ?? 0,
    };
  }

  // ── Mutations (Execution Lifecycle) ────────────────────────────────────

  /**
   * Start a new execution log when a workflow is triggered.
   */
  async startExecution(data: {
    tenantId: string;
    workflowId: string;
    workflowName: string;
    recordId: string;
    recordType: 'Lead' | 'Contact' | 'Ticket' | 'Deal' | 'Account' | 'Task';
    automationDepth: number;
  }) {
    const now = new Date();
    const expireAt = new Date(
      now.getTime() + LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    const doc = await this.model.create({
      ...data,
      status: 'running',
      startedAt: now,
      completedAt: null,
      duration: 0,
      steps: [],
      error: null,
      expireAt,
    });

    return doc.toObject();
  }

  /**
   * Append a step to an existing execution log.
   * Uses $push for atomic array append.
   */
  async logStep(executionId: string, step: ExecutionStep): Promise<void> {
    await this.model
      .updateOne({ _id: executionId }, { $push: { steps: step } })
      .exec();
  }

  /**
   * Mark execution as completed successfully.
   */
  async completeExecution(executionId: string): Promise<void> {
    const now = new Date();
    const doc = await this.model
      .findById(executionId)
      .select('startedAt')
      .lean()
      .exec();
    const duration = doc
      ? now.getTime() - new Date(doc.startedAt).getTime()
      : 0;

    await this.model
      .updateOne(
        { _id: executionId },
        {
          $set: {
            status: 'success',
            completedAt: now,
            duration,
          },
        },
      )
      .exec();
  }

  /**
   * Mark execution as failed with error details.
   */
  async failExecution(
    executionId: string,
    error: { code: string; message: string; nodeId?: string },
  ): Promise<void> {
    const now = new Date();
    const doc = await this.model
      .findById(executionId)
      .select('startedAt')
      .lean()
      .exec();
    const duration = doc
      ? now.getTime() - new Date(doc.startedAt).getTime()
      : 0;

    await this.model
      .updateOne(
        { _id: executionId },
        {
          $set: {
            status: 'failed',
            completedAt: now,
            duration,
            error,
          },
        },
      )
      .exec();
  }

  /**
   * Mark execution as blocked by loop prevention.
   */
  async blockExecution(
    executionId: string,
    error: { code: string; message: string; nodeId?: string },
  ): Promise<void> {
    const now = new Date();

    await this.model
      .updateOne(
        { _id: executionId },
        {
          $set: {
            status: 'loop_blocked',
            completedAt: now,
            error,
          },
        },
      )
      .exec();
  }

  /**
   * Mark execution as skipped by run-once-per-record rule.
   */
  async skipExecution(executionId: string): Promise<void> {
    const now = new Date();

    await this.model
      .updateOne(
        { _id: executionId },
        {
          $set: {
            status: 'skipped_run_once',
            completedAt: now,
            duration: 0,
          },
        },
      )
      .exec();
  }

  // ── DLQ & Retry Support ──────────────────────────────────────────────────

  /**
   * Atomically mark a failed/dlq step as 'retrying'.
   * Idempotency guard: only transitions from 'failed' or 'dlq'.
   * Returns true if the transition was successful, false if step was not in a retryable state.
   */
  async retryStep(executionId: string, nodeId: string): Promise<boolean> {
    const result = await this.model
      .updateOne(
        {
          _id: executionId,
          'steps.nodeId': nodeId,
          'steps.status': { $in: ['failed', 'dlq'] },
        },
        {
          $set: { 'steps.$.status': 'retrying' },
        },
      )
      .exec();

    return result.modifiedCount > 0;
  }

  /**
   * Mark a step as dead-lettered after exhausting all retry attempts.
   */
  async markStepDlq(executionId: string, nodeId: string): Promise<void> {
    await this.model
      .updateOne(
        {
          _id: executionId,
          'steps.nodeId': nodeId,
        },
        {
          $set: { 'steps.$.status': 'dlq' },
        },
      )
      .exec();
  }

  /**
   * Retrieve step data for re-dispatch during manual retry.
   */
  async getStepData(
    executionId: string,
    nodeId: string,
  ): Promise<{ step: any; executionLog: any } | null> {
    const log = await this.model.findById(executionId).lean().exec();

    if (!log) return null;

    const step = log.steps.find((s: any) => s.nodeId === nodeId);
    if (!step) return null;

    return { step, executionLog: log };
  }
}
