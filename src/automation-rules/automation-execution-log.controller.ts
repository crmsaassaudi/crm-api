import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { AutomationExecutionLogRepository } from './infrastructure/persistence/document/repositories/automation-execution-log.repository';

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
  ) {}

  private get tenantId(): string {
    return this.cls.get('tenantId');
  }

  @Get()
  @ApiOperation({ summary: 'List execution logs with filters' })
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
  async getStats(@Param('workflowId') workflowId: string) {
    return this.repo.getWorkflowStats(this.tenantId, workflowId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get execution log detail with step trace' })
  async findById(@Param('id') id: string) {
    return this.repo.findByIdWithSteps(this.tenantId, id);
  }
}
