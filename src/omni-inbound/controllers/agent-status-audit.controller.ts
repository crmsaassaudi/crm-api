import {
  Controller,
  Get,
  Param,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  AgentStatusAuditService,
  AgentWorkTimeSummary,
} from '../services/agent-status-audit.service';

/**
 * REST endpoints for agent work time reporting.
 *
 * Used by managers/supervisors to track agent KPIs:
 *   - How long each agent was Available/Busy/Away/Offline per day
 *   - Status transition history (drill-down)
 */
@Controller({ path: 'omni/agents', version: '1' })
export class AgentStatusAuditController {
  constructor(
    private readonly auditService: AgentStatusAuditService,
    private readonly cls: ClsService,
  ) {}

  /**
   * GET /api/v1/omni/agents/work-time?date=2026-04-16
   *
   * Returns work time summary for ALL agents in the tenant.
   * Used for the team dashboard / daily KPI overview.
   */
  @Get('work-time')
  async getTeamWorkTime(
    @Query('date') date?: string,
  ): Promise<{ data: AgentWorkTimeSummary[] }> {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context not found');
    }

    const targetDate = date ?? new Date().toISOString().slice(0, 10);
    const summaries = await this.auditService.getTeamWorkTimeSummary(
      tenantId,
      targetDate,
    );
    return { data: summaries };
  }

  /**
   * GET /api/v1/omni/agents/:agentId/work-time?date=2026-04-16
   *
   * Returns work time summary for a single agent.
   * Used for individual agent KPI detail view.
   */
  @Get(':agentId/work-time')
  async getAgentWorkTime(
    @Param('agentId') agentId: string,
    @Query('date') date?: string,
  ): Promise<{ data: AgentWorkTimeSummary }> {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context not found');
    }

    const targetDate = date ?? new Date().toISOString().slice(0, 10);
    const summary = await this.auditService.getAgentWorkTimeSummary(
      tenantId,
      agentId,
      targetDate,
    );
    return { data: summary };
  }
}
