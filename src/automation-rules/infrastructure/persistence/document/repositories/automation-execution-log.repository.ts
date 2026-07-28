import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AutomationExecutionLogSchemaClass,
  ExecutionStatus,
  ExecutionStep,
} from '../entities/automation-execution-log.schema';

const LOG_RETENTION_DAYS = 30;

/**
 * Hard ceiling on the embedded `steps` array, applied with `$slice` so the oldest
 * steps are dropped rather than the write failing.
 *
 * `steps` is an unbounded embedded array whose entries carry Mixed input/output.
 * The orchestrator's own MAX_TOTAL_STEPS is 1000, and a wait-node execution can
 * append across many resumes, so a single document could grow past MongoDB's
 * 16 MB limit — at which point every further write on that execution fails.
 * Keeping the most recent 200 keeps the trace useful and the document bounded.
 */
const MAX_LOGGED_STEPS = 200;

/**
 * Stop counting matched logs at this point. The list view only needs a page
 * count, and an exact `countDocuments` over this collection is a full index scan
 * per request.
 */
const COUNT_CAP = 10_000;

/** Deepest offset the list view will serve — past this, filtering is the answer. */
const MAX_SKIP = 10_000;

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
  ): Promise<{ data: any[]; total: number; totalIsCapped: boolean }> {
    if (skip > MAX_SKIP) {
      throw new BadRequestException(
        `Cannot page beyond ${MAX_SKIP} execution logs. Narrow the range with ` +
          'workflowId, status or a from/to window instead of paging deeper.',
      );
    }

    const [data, total] = await Promise.all([
      this.model
        .find(filter)
        .sort({ startedAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-steps') // Exclude steps for list view performance
        .lean()
        .exec(),
      // Bounded count: an exact count over a collection sized for the automation
      // engine's write volume is a full index scan on every page render, and its
      // only consumer is a page-number widget. Stop counting at the cap and say
      // so.
      this.model.countDocuments(filter).limit(COUNT_CAP).exec(),
    ]);

    return { data, total, totalIsCapped: total >= COUNT_CAP };
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
    // MED-10: Single $facet replaces two parallel aggregation scans.
    const [result] = await this.model.aggregate([
      { $match: { tenantId, workflowId } },
      {
        $facet: {
          statusCounts: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          avgDuration: [
            { $match: { status: 'success' } },
            {
              $group: {
                _id: null,
                avgDuration: { $avg: '$duration' },
                total: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]);

    const statusCounts = result?.statusCounts ?? [];
    const avgDuration = result?.avgDuration ?? [];

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
    recordType:
      | 'Lead'
      | 'Contact'
      | 'Ticket'
      | 'Deal'
      | 'Account'
      | 'Task'
      | 'Conversation'
      | 'Message';
    automationDepth: number;
    /** Published version being executed; null for a pre-versioning execution. */
    workflowVersion?: number | null;
  }) {
    const now = new Date();
    const expireAt = new Date(
      now.getTime() + LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    const doc = await this.model.create({
      ...data,
      workflowVersion: data.workflowVersion ?? null,
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
   * Uses $push for atomic array append, bounded by MAX_LOGGED_STEPS.
   */
  async logStep(executionId: string, step: ExecutionStep): Promise<void> {
    await this.model
      .updateOne(
        { _id: executionId },
        { $push: { steps: { $each: [step], $slice: -MAX_LOGGED_STEPS } } },
      )
      .exec();
  }

  /**
   * Append multiple steps in one atomic update.
   * Used by the orchestrator to avoid one MongoDB write per DAG node.
   */
  async logSteps(executionId: string, steps: ExecutionStep[]): Promise<void> {
    if (steps.length === 0) return;

    await this.model
      .updateOne(
        { _id: executionId },
        { $push: { steps: { $each: steps, $slice: -MAX_LOGGED_STEPS } } },
      )
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
