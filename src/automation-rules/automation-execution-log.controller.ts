import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  BadRequestException,
  ForbiddenException,
  Inject,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import Redis from 'ioredis';
import { ulid } from 'ulid';
import { resolvePrincipal } from './domain/execution-principal';
import { AutomationExecutionLogRepository } from './infrastructure/persistence/document/repositories/automation-execution-log.repository';
import { AutomationWorkflowRepository } from './infrastructure/persistence/document/repositories/automation-workflow.repository';
import { AutomationActionProducer } from './queue/automation-action.producer';
import { CrmRecordUpdateService } from './engine/crm-record-update.service';
import { AutomationAuditService } from './automation-audit.service';
import { RetryStepDto } from './dto/workflow.dto';
import { RequirePermission } from '../common/permissions';
import { AuthorizationService } from '../common/permissions/authorization.service';
import { IOREDIS_CLIENT } from '../redis/redis.tokens';
import { POISON_THRESHOLD } from './queue/automation-dlq.processor';
import { ActionIdempotencyService } from './engine/action-idempotency.service';
import { AutomationActionJobData } from './queue/automation-queue.constants';

/** Minimum gap between two manual retries of the same step. */
const RETRY_COOLDOWN_SECONDS = 60;

/**
 * AutomationExecutionLogController — REST API for querying execution logs.
 *
 * Supports filtering by workflowId, status, recordId, and date range.
 * Provides detail endpoint with full step-by-step trace for debugging.
 */
@ApiTags('Automation Execution Logs')
@ApiBearerAuth()
@Controller({ path: 'automation-execution-logs', version: '1' })
export class AutomationExecutionLogController {
  constructor(
    private readonly repo: AutomationExecutionLogRepository,
    private readonly cls: ClsService,
    private readonly actionProducer: AutomationActionProducer,
    private readonly crmRecordUpdate: CrmRecordUpdateService,
    private readonly workflowRepo: AutomationWorkflowRepository,
    private readonly auditService: AutomationAuditService,
    private readonly authz: AuthorizationService,
    private readonly idempotency: ActionIdempotencyService,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private get tenantId(): string {
    return this.cls.get('tenantId');
  }

  @Get()
  @ApiOperation({ summary: 'List execution logs with filters' })
  @RequirePermission('view', 'automation_logs')
  @ApiQuery({ name: 'workflowId', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['running', 'success', 'failed', 'loop_blocked', 'skipped_run_once'],
  })
  @ApiQuery({ name: 'recordId', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findAll(
    @Query('workflowId') workflowId?: string,
    @Query('status') status?: string,
    @Query('recordId') recordId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = parseInt(page ?? '1', 10);
    const limitNum = Math.min(parseInt(limit ?? '20', 10), 100);
    const skip = (pageNum - 1) * limitNum;

    const filter: Record<string, any> = { tenantId: this.tenantId };

    if (workflowId) filter.workflowId = workflowId;
    if (status) filter.status = status;
    if (recordId) filter.recordId = recordId;

    if (from || to) {
      filter.startedAt = {};
      if (from) filter.startedAt.$gte = new Date(from);
      if (to) filter.startedAt.$lte = new Date(to);
    }

    const { data, total, totalIsCapped } = await this.repo.findWithPagination(
      filter,
      skip,
      limitNum,
    );

    return {
      data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
        /**
         * True when the match set is larger than the counting cap, so `total` is
         * a floor rather than an exact figure. Surfaced rather than hidden: a
         * page count that silently lies is worse than one that says "10,000+".
         */
        totalIsCapped,
      },
    };
  }

  @Get('stats/:workflowId')
  @ApiOperation({ summary: 'Get execution stats for a workflow' })
  @RequirePermission('view', 'automation_logs')
  async getStats(@Param('workflowId') workflowId: string) {
    return this.repo.getWorkflowStats(this.tenantId, workflowId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get execution log detail with step trace' })
  @RequirePermission('view', 'automation_logs')
  async findById(@Param('id') id: string) {
    return this.repo.findByIdWithSteps(this.tenantId, id);
  }

  // Manual Retry

  @Post(':id/retry-step')
  @ApiOperation({
    summary:
      'Retry a failed/DLQ step — re-dispatch the action to the main queue',
  })
  @RequirePermission('retry', 'automation_logs')
  async retryStep(@Param('id') id: string, @Body() dto: RetryStepDto) {
    // 1. Retrying an action executes it for real, with the engine's full
    //    tenant-wide reach and none of the request-scoped authorization the
    //    caller is otherwise subject to. `automation_logs:retry` alone is a
    //    grant a "support can re-run failed jobs" role would plausibly get, so
    //    require the workflow-administration permission on top of it.
    await this.assertMayExecuteAutomation();

    // 2. Verify execution log and step exist
    const { step, executionLog } = await this.fetchRetryStepData(
      id,
      dto.nodeId,
    );

    // 3. Re-resolve the action from the workflow's CURRENT published snapshot.
    //    Reading the config back out of the log made retry un-revocable: an
    //    action stayed executable for the log's 30-day retention even after the
    //    node was edited, the workflow unpublished, paused or deleted.
    const { node, workflow } = await this.resolveLivePublishedNode(
      executionLog.workflowId?.toString(),
      dto.nodeId,
    );

    // 4. Refuse to re-fire a node the DLQ processor has quarantined. Retrying a
    //    node that has already dead-lettered dozens of times in the last hour
    //    sends the same doomed request again; the config is what needs fixing.
    await this.assertNodeNotQuarantined(
      executionLog.workflowId?.toString(),
      dto.nodeId,
    );

    // 5. One retry per step per window. The step-state transition below already
    //    serialises retries, but an action that keeps failing can be re-fired in
    //    a tight loop — and a webhook sends its request before it fails.
    await this.assertRetryNotRateLimited(id, dto.nodeId);

    // 6. Atomic state guard: only failed/dlq steps can be retried
    const transitioned = await this.repo.retryStep(id, dto.nodeId);
    if (!transitioned) {
      throw new BadRequestException(
        'Step is not in a retryable state. Only failed or DLQ steps can be retried.',
      );
    }

    // 7. Clear the exactly-once claim. A step that reached the DLQ still holds a
    //    confirmed claim, so without this the redispatched job would be skipped
    //    as a duplicate and the retry would silently do nothing.
    await this.idempotency.release({
      tenantId: this.tenantId,
      executionId: id,
      nodeId: dto.nodeId,
    } as any);

    // 8. Re-dispatch the action job.
    const jobData = await this.buildRetryJobData(
      id,
      dto.nodeId,
      step,
      executionLog,
      node,
      workflow,
    );
    await this.actionProducer.dispatch(
      jobData,
      // Unique jobId so the manual retry is not deduped against the original
      // failed job (CRIT-02 idempotency uses a deterministic jobId).
      { jobId: `${id}:${dto.nodeId}:retry:${Date.now()}` },
    );

    // 9. A manual re-execution is a privileged act; record who did it.
    await this.auditService.logAction({
      tenantId: this.tenantId,
      userId: this.actorId,
      workflowId: executionLog.workflowId?.toString() ?? '',
      workflowName: executionLog.workflowName ?? '(unknown)',
      action: 'step_retried',
      metadata: {
        executionId: id,
        nodeId: dto.nodeId,
        actionType: node.config?.actionType,
        recordType: executionLog.recordType,
        recordId: executionLog.recordId,
      },
    });

    return {
      message: 'Step retry dispatched successfully',
      nodeId: dto.nodeId,
    };
  }

  private get actorId(): string {
    return this.cls.get('userId') ?? this.cls.get('user.id') ?? 'system';
  }

  /**
   * Require `settings:manage_system` in addition to the route's
   * `automation_logs:retry`. `RequirePermission` carries a single rule, so the
   * second check is made here against the same PDP the guard uses.
   */
  private async assertMayExecuteAutomation(): Promise<void> {
    const rawUserId = this.actorId;
    const decision = await this.authz.canPerformAction({
      rule: { action: 'manage_system', resource: 'settings' },
      rawUserId,
      tenantHint: this.tenantId,
      claims: this.cls.get('user'),
    });

    if (!decision.allowed) {
      throw new ForbiddenException(
        'Retrying an automation step re-executes it with engine privileges and ' +
          'additionally requires settings:manage_system.',
      );
    }
  }

  /**
   * Fetch the node as it exists in the workflow's live published snapshot.
   * Refuses when the workflow is gone, no longer published, not active, or the
   * node has been removed — so revoking a workflow revokes its retries too.
   */
  private async resolveLivePublishedNode(
    workflowId: string | undefined,
    nodeId: string,
  ): Promise<{ node: any; workflow: any }> {
    if (!workflowId) {
      throw new BadRequestException(
        'Execution log has no workflow reference; it cannot be retried.',
      );
    }

    const workflow = await this.workflowRepo.findById(
      this.tenantId,
      workflowId,
    );
    if (!workflow) {
      throw new NotFoundException(
        'The workflow this step belongs to no longer exists; retry refused.',
      );
    }
    if (workflow.status !== 'active') {
      throw new BadRequestException(
        `Workflow is "${workflow.status}". Only steps of an active workflow can be retried.`,
      );
    }

    const node = ((workflow as any).publishedNodes ?? []).find(
      (n: any) => n.id === nodeId,
    );
    if (!node) {
      throw new BadRequestException(
        `Node "${nodeId}" is not part of the workflow's current published version; ` +
          'it may have been edited or removed. Republish before retrying.',
      );
    }
    if (node.type !== 'action') {
      throw new BadRequestException(
        `Node "${nodeId}" is a ${node.type} node; only action nodes can be retried.`,
      );
    }
    return { node, workflow };
  }

  /**
   * Refuse a retry for a node the DLQ processor has flagged as poison. Mirrors
   * the key written by AutomationDlqProcessor.trackPoisonNode.
   */
  private async assertNodeNotQuarantined(
    workflowId: string | undefined,
    nodeId: string,
  ): Promise<void> {
    if (!workflowId) return;

    const key = `automation:poison:${this.tenantId}:${workflowId}:${nodeId}`;
    const failures = Number((await this.redis.get(key)) ?? 0);
    if (failures >= POISON_THRESHOLD) {
      throw new BadRequestException(
        `This step has dead-lettered ${failures} times in the last hour and is ` +
          'quarantined. Fix the node configuration and republish the workflow ' +
          'instead of retrying.',
      );
    }
  }

  private async assertRetryNotRateLimited(
    executionId: string,
    nodeId: string,
  ): Promise<void> {
    const key = `automation:retry:${this.tenantId}:${executionId}:${nodeId}`;
    const acquired = await this.redis.set(
      key,
      '1',
      'EX',
      RETRY_COOLDOWN_SECONDS,
      'NX',
    );
    if (acquired !== 'OK') {
      throw new BadRequestException(
        `This step was retried in the last ${RETRY_COOLDOWN_SECONDS}s. ` +
          'Wait for the dispatched attempt to finish before retrying again.',
      );
    }
  }

  /** Validate that the execution log and requested step both exist. */
  private async fetchRetryStepData(
    executionId: string,
    nodeId: string,
  ): Promise<{ step: any; executionLog: any }> {
    const log = await this.repo.findByIdWithSteps(this.tenantId, executionId);
    if (!log) throw new NotFoundException('Execution log not found');

    const stepData = await this.repo.getStepData(executionId, nodeId);
    if (!stepData) {
      throw new NotFoundException(
        `Step with nodeId "${nodeId}" not found in execution log`,
      );
    }
    return stepData;
  }

  /**
   * Build the action job payload for retry, re-fetching the latest record
   * so templates and recipient resolution have real data (CRIT-03).
   *
   * The action type and config come from `node` — the live published snapshot —
   * not from the log, so an edited or revoked action is not resurrected. Loop
   * metadata is carried over so a retried action cannot restart the chain with
   * an empty breadcrumb trail.
   */
  private async buildRetryJobData(
    executionId: string,
    nodeId: string,
    step: any,
    executionLog: any,
    node: any,
    workflow: any,
  ): Promise<AutomationActionJobData> {
    // The record is re-read so templates and recipient resolution work against
    // current data. There is no fallback to the copy in the step log: a retry
    // that quietly sends against a month-old snapshot is worse than one that
    // refuses.
    const recordData = await this.crmRecordUpdate.fetchRecord(
      executionLog.recordType,
      executionLog.recordId,
    );
    if (!recordData) {
      throw new BadRequestException(
        `${executionLog.recordType}(${executionLog.recordId}) no longer exists ` +
          'or is not visible to you, so this step cannot be retried.',
      );
    }

    const workflowId = executionLog.workflowId?.toString() ?? '';
    const actionConfig = node.config ?? {};

    return {
      executionId,
      workflowId,
      tenantId: this.tenantId,
      nodeId,
      nodeName: actionConfig.name ?? step.nodeName,
      actionType: actionConfig.actionType,
      actionConfig,
      recordId: executionLog.recordId,
      recordType: executionLog.recordType,
      recordData,
      automationDepth: executionLog.automationDepth ?? 0,
      // Without the breadcrumb the retried action's own cascade would look like
      // a fresh chain to the loop guard.
      automationBreadcrumbs: [workflowId],
      sourceWorkflowId: workflowId,
      // A manual retry is its own loop-guard session: the original session's
      // strict-loop counters expired long ago, and reusing its id would make the
      // retry look like a repeat visit to the same node.
      executionSessionId: ulid(),
      // The graph is pinned from the version being retried, so continuing past
      // this action follows the branches the operator can see on screen.
      workflowVersion: workflow.version ?? null,
      publishedNodes: workflow.publishedNodes ?? [],
      publishedEdges: workflow.publishedEdges ?? [],
      // Same principal resolution the orchestrator applies, so a retry cannot
      // widen the scope the execution originally ran with.
      principal: resolvePrincipal({
        runAs: workflow.runAs,
        workflowId,
        workflowCreatedBy: workflow.createdBy,
        recordOwnerId: recordData.ownerId,
      }),
    };
  }
}
