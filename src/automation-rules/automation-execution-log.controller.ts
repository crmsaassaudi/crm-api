import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { AutomationExecutionLogRepository } from './infrastructure/persistence/document/repositories/automation-execution-log.repository';
import { AutomationActionProducer } from './queue/automation-action.producer';
import { RetryStepDto } from './dto/workflow.dto';
import { RequirePermission } from '../common/permissions';

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
    const pageNum = parseInt(page || '1', 10);
    const limitNum = Math.min(parseInt(limit || '20', 10), 100);
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

    const [data, total] = await this.repo.findWithPagination(
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

  // ── Manual Retry ────────────────────────────────────────────────────────

  @Post(':id/retry-step')
  @ApiOperation({
    summary:
      'Retry a failed/DLQ step — re-dispatch the action to the main queue',
  })
  @RequirePermission('retry', 'automation_logs')
  async retryStep(@Param('id') id: string, @Body() dto: RetryStepDto) {
    // 1. Verify execution log exists
    const log = await this.repo.findByIdWithSteps(this.tenantId, id);
    if (!log) throw new NotFoundException('Execution log not found');

    // 2. Get the step data for re-dispatch
    const stepData = await this.repo.getStepData(id, dto.nodeId);
    if (!stepData) {
      throw new NotFoundException(
        `Step with nodeId "${dto.nodeId}" not found in execution log`,
      );
    }

    // 3. Atomic idempotency guard: only failed/dlq steps can be retried
    const transitioned = await this.repo.retryStep(id, dto.nodeId);
    if (!transitioned) {
      throw new BadRequestException(
        'Step is not in a retryable state. Only failed or DLQ steps can be retried.',
      );
    }

    // 4. Re-dispatch the action job using original data from the step
    const { step, executionLog } = stepData;
    await this.actionProducer.dispatch({
      executionId: id,
      workflowId: executionLog.workflowId?.toString() || '',
      tenantId: this.tenantId,
      nodeId: dto.nodeId,
      nodeName: step.nodeName,
      actionType: step.input?.actionType || 'send_email',
      actionConfig: step.input?.config || {},
      recordId: executionLog.recordId,
      recordType: executionLog.recordType,
      recordData: {},
      automationDepth: executionLog.automationDepth || 0,
      sourceWorkflowId: executionLog.workflowId?.toString() || '',
    });

    return {
      message: 'Step retry dispatched successfully',
      nodeId: dto.nodeId,
    };
  }
}
