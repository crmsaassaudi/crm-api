import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClsService } from 'nestjs-cls';
import { Model, Types } from 'mongoose';
import { AgentStateSegmentSchemaClass } from '../../omni-inbound/infrastructure/persistence/document/entities/agent-state-segment.schema';
import { InteractionSegmentSchemaClass } from '../../omni-inbound/infrastructure/persistence/document/entities/interaction-segment.schema';
import { UsersService } from '../../users/users.service';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { ReportResponse } from '../shared/interfaces/report-response.interface';
import { buildReportResponse } from '../shared/utils/report-response.util';
import { GetAgentReportDto } from './dto/get-agent-report.dto';
import {
  AgentRankingData,
  AgentRankingItem,
  AgentWorkTimeData,
  AgentWorkTimeItem,
  ChannelHandle,
} from './interfaces/agent-report-types';
import {
  KpiDurations,
  computeKpis,
  formatDuration,
  minMaxNormalize,
} from './agent-kpi.util';

const CHANNELS = ['chat', 'ticket', 'email', 'call'] as const;
type Channel = (typeof CHANNELS)[number];

const HANDLE_WORK = ['IN_CHAT', 'IN_TICKET', 'IN_EMAIL', 'IN_CALL'];

const DEFAULT_WEIGHTS = {
  occupancy: 0.2,
  availability: 0.15,
  handled: 0.2,
  aht: 0.15,
  sla: 0.15,
  csat: 0.15,
};

@Injectable()
export class AgentReportService {
  constructor(
    @InjectModel(AgentStateSegmentSchemaClass.name)
    private readonly stateModel: Model<AgentStateSegmentSchemaClass>,
    @InjectModel(InteractionSegmentSchemaClass.name)
    private readonly interactionModel: Model<InteractionSegmentSchemaClass>,
    private readonly cls: ClsService,
    private readonly usersService: UsersService,
    private readonly settingsService: CrmSettingsService,
  ) {}

  // ── Report: Work time + KPIs ───────────────────────────────────────────────

  async getWorkTime(
    dto: GetAgentReportDto,
  ): Promise<ReportResponse<AgentWorkTimeData>> {
    const startedAt = process.hrtime.bigint();
    const agents = await this.buildAgents(dto);

    const team = agents.reduce(
      (acc, a) => {
        acc.onlineMs += a.onlineMs;
        acc.availableMs += a.presence.availableMs;
        acc.handleMs += a.work.handleMs;
        acc.handledCount += a.handledCount;
        acc.occSum += a.occupancy;
        acc.utilSum += a.utilization;
        return acc;
      },
      {
        onlineMs: 0,
        availableMs: 0,
        handleMs: 0,
        handledCount: 0,
        occSum: 0,
        utilSum: 0,
      },
    );
    const n = agents.length || 1;

    const data: AgentWorkTimeData = {
      agents,
      team: {
        agentCount: agents.length,
        onlineMs: team.onlineMs,
        availableMs: team.availableMs,
        handleMs: team.handleMs,
        handledCount: team.handledCount,
        avgOccupancy: team.occSum / n,
        avgUtilization: team.utilSum / n,
      },
    };

    return buildReportResponse({
      report: 'agent_work_time',
      dto,
      data,
      totalRecords: agents.length,
      startedAt,
    });
  }

  // ── Report: Ranking (Agent Performance Index) ──────────────────────────────

  async getRanking(
    dto: GetAgentReportDto,
  ): Promise<ReportResponse<AgentRankingData>> {
    const startedAt = process.hrtime.bigint();
    const agents = await this.buildAgents(dto);
    const { weights, minOnlineMinutes, minHandled } =
      await this.resolveRankingConfig();

    const minOnlineMs = minOnlineMinutes * 60_000;
    const eligible = agents.filter(
      (a) => a.onlineMs >= minOnlineMs && a.handledCount >= minHandled,
    );

    // Normalize each component across eligible agents.
    const nOcc = minMaxNormalize(eligible.map((a) => a.occupancy));
    const nAvail = minMaxNormalize(eligible.map((a) => a.availabilityRatio));
    const nHandled = minMaxNormalize(eligible.map((a) => a.handledCount));
    const nAht = minMaxNormalize(eligible.map((a) => a.ahtMs)); // lower better → invert

    // v1 uses the 4 locally-available metrics; SLA/CSAT integration is deferred,
    // so renormalize their weights over the available four.
    const wSum =
      weights.occupancy +
        weights.availability +
        weights.handled +
        weights.aht || 1;

    const scored: AgentRankingItem[] = eligible.map((a, i) => ({
      agentId: a.agentId,
      agentName: a.agentName,
      rank: null,
      ranked: true,
      score:
        (weights.occupancy * nOcc[i] +
          weights.availability * nAvail[i] +
          weights.handled * nHandled[i] +
          weights.aht * (1 - nAht[i])) /
        wSum,
      components: {
        occupancy: a.occupancy,
        availabilityRatio: a.availabilityRatio,
        handledCount: a.handledCount,
        ahtMs: a.ahtMs,
      },
    }));

    scored.sort((x, y) => y.score - x.score);
    scored.forEach((s, i) => (s.rank = i + 1));

    const unranked: AgentRankingItem[] = agents
      .filter((a) => !eligible.includes(a))
      .map((a) => ({
        agentId: a.agentId,
        agentName: a.agentName,
        rank: null,
        ranked: false,
        notRankedReason:
          a.onlineMs < minOnlineMs
            ? `online < ${minOnlineMinutes}m`
            : `handled < ${minHandled}`,
        score: 0,
        components: {
          occupancy: a.occupancy,
          availabilityRatio: a.availabilityRatio,
          handledCount: a.handledCount,
          ahtMs: a.ahtMs,
        },
      }));

    const data: AgentRankingData = {
      weights,
      thresholds: { minOnlineMinutes, minHandled },
      agents: [...scored, ...unranked],
    };

    return buildReportResponse({
      report: 'agent_ranking',
      dto,
      data,
      totalRecords: data.agents.length,
      startedAt,
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async buildAgents(
    dto: GetAgentReportDto,
  ): Promise<AgentWorkTimeItem[]> {
    const tenantId = new Types.ObjectId(this.cls.get<string>('tenantId'));
    const fromDay = dto.fromDate.slice(0, 10);
    const toDay = dto.toDate.slice(0, 10);
    const dayKey = { $gte: fromDay, $lte: toDay };
    const agentMatch = dto.agentId ? { agentId: dto.agentId } : {};

    const [stateRows, interactionRows] = await Promise.all([
      this.stateModel.aggregate<{
        _id: { agentId: string; axis: string; value: string };
        durationMs: number;
      }>([
        { $match: { tenantId, dayKey, ...agentMatch } },
        {
          $group: {
            _id: { agentId: '$agentId', axis: '$axis', value: '$value' },
            durationMs: { $sum: '$durationMs' },
          },
        },
      ]),
      this.interactionModel.aggregate<{
        _id: { agentId: string; type: string };
        durationMs: number;
        count: number;
      }>([
        { $match: { tenantId, dayKey, ...agentMatch } },
        {
          $group: {
            _id: { agentId: '$agentId', type: '$type' },
            durationMs: { $sum: '$durationMs' },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const acc = this.pivotStateRows(stateRows);
    this.pivotInteractionRows(interactionRows, acc);

    const agentIds = [...acc.keys()];
    const nameMap = await this.resolveNames(agentIds);
    return agentIds.map((agentId) =>
      this.assembleAgentItem(agentId, acc, nameMap),
    );
  }

  /**
   * Pivot raw state aggregation rows into per-agent KPI accumulators.
   */
  private pivotStateRows(
    stateRows: {
      _id: { agentId: string; axis: string; value: string };
      durationMs: number;
    }[],
  ): Map<string, KpiDurations & { byChannel: Record<Channel, ChannelHandle> }> {
    const acc = new Map<
      string,
      KpiDurations & { byChannel: Record<Channel, ChannelHandle> }
    >();
    const ensure = (agentId: string) => {
      let v = acc.get(agentId);
      if (!v) {
        v = {
          availableMs: 0,
          awayMs: 0,
          breakMs: 0,
          meetingMs: 0,
          trainingMs: 0,
          acceptingMs: 0,
          notAcceptingMs: 0,
          handleMs: 0,
          wrapMs: 0,
          idleMs: 0,
          handledCount: 0,
          byChannel: {
            chat: { durationMs: 0, durationFormatted: '0m', count: 0 },
            ticket: { durationMs: 0, durationFormatted: '0m', count: 0 },
            email: { durationMs: 0, durationFormatted: '0m', count: 0 },
            call: { durationMs: 0, durationFormatted: '0m', count: 0 },
          },
        };
        acc.set(agentId, v);
      }
      return v;
    };

    for (const row of stateRows) {
      const v = ensure(row._id.agentId);
      const ms = row.durationMs;
      const value = row._id.value;
      if (row._id.axis === 'presence') {
        this.applyPresenceRow(v, value, ms);
      } else if (row._id.axis === 'routing') {
        if (value === 'ACCEPTING') v.acceptingMs += ms;
        else if (value === 'NOT_ACCEPTING') v.notAcceptingMs += ms;
      } else if (row._id.axis === 'work') {
        if (HANDLE_WORK.includes(value)) v.handleMs += ms;
        else if (value === 'WRAP_UP') v.wrapMs += ms;
        else if (value === 'IDLE') v.idleMs += ms;
      }
    }
    return acc;
  }

  private applyPresenceRow(
    v: KpiDurations & { byChannel: Record<Channel, ChannelHandle> },
    value: string,
    ms: number,
  ): void {
    if (value === 'AVAILABLE') v.availableMs += ms;
    else if (value === 'AWAY') v.awayMs += ms;
    else if (value === 'BREAK') v.breakMs += ms;
    else if (value === 'MEETING') v.meetingMs += ms;
    else if (value === 'TRAINING') v.trainingMs += ms;
  }

  /**
   * Pivot raw interaction aggregation rows into per-agent accumulators.
   */
  private pivotInteractionRows(
    interactionRows: {
      _id: { agentId: string; type: string };
      durationMs: number;
      count: number;
    }[],
    acc: Map<
      string,
      KpiDurations & { byChannel: Record<Channel, ChannelHandle> }
    >,
  ): void {
    const ensure = (agentId: string) => {
      let v = acc.get(agentId);
      if (!v) {
        v = {
          availableMs: 0,
          awayMs: 0,
          breakMs: 0,
          meetingMs: 0,
          trainingMs: 0,
          acceptingMs: 0,
          notAcceptingMs: 0,
          handleMs: 0,
          wrapMs: 0,
          idleMs: 0,
          handledCount: 0,
          byChannel: {
            chat: { durationMs: 0, durationFormatted: '0m', count: 0 },
            ticket: { durationMs: 0, durationFormatted: '0m', count: 0 },
            email: { durationMs: 0, durationFormatted: '0m', count: 0 },
            call: { durationMs: 0, durationFormatted: '0m', count: 0 },
          },
        };
        acc.set(agentId, v);
      }
      return v;
    };
    for (const row of interactionRows) {
      const v = ensure(row._id.agentId);
      const ch = row._id.type as Channel;
      if (CHANNELS.includes(ch)) {
        v.byChannel[ch] = {
          durationMs: row.durationMs,
          durationFormatted: formatDuration(row.durationMs),
          count: row.count,
        };
        v.handledCount += row.count;
      }
    }
  }

  /**
   * Build a single AgentWorkTimeItem from accumulated data.
   */
  private assembleAgentItem(
    agentId: string,
    acc: Map<
      string,
      KpiDurations & { byChannel: Record<Channel, ChannelHandle> }
    >,
    nameMap: Map<string, { name: string; email: string }>,
  ): AgentWorkTimeItem {
    const v = acc.get(agentId)!;
    const kpis = computeKpis(v);
    const info = nameMap.get(agentId) ?? {
      name: 'Unknown Agent',
      email: 'no-email',
    };
    return {
      agentId,
      agentName: info.name,
      agentEmail: info.email,
      presence: {
        availableMs: v.availableMs,
        awayMs: v.awayMs,
        breakMs: v.breakMs,
        meetingMs: v.meetingMs,
        trainingMs: v.trainingMs,
      },
      onlineMs: kpis.onlineMs,
      routing: {
        acceptingMs: v.acceptingMs,
        notAcceptingMs: v.notAcceptingMs,
      },
      work: { handleMs: v.handleMs, wrapMs: v.wrapMs, idleMs: v.idleMs },
      handledCount: v.handledCount,
      byChannel: v.byChannel,
      occupancy: kpis.occupancy,
      utilization: kpis.utilization,
      availabilityRatio: kpis.availabilityRatio,
      idleRatio: kpis.idleRatio,
      ahtMs: kpis.ahtMs,
      onlineFormatted: formatDuration(kpis.onlineMs),
      availableFormatted: formatDuration(v.availableMs),
      handleFormatted: formatDuration(v.handleMs),
      wrapFormatted: formatDuration(v.wrapMs),
      ahtFormatted: formatDuration(kpis.ahtMs),
    };
  }

  private async resolveNames(
    agentIds: string[],
  ): Promise<Map<string, { name: string; email: string }>> {
    const map = new Map<string, { name: string; email: string }>();
    if (agentIds.length === 0) return map;
    try {
      const users = await this.usersService.findByIdsGlobal(agentIds);
      for (const u of users) {
        map.set(u.id.toString(), {
          name:
            `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() ||
            'Unknown Agent',
          email: u.email ?? 'no-email',
        });
      }
    } catch {
      // Name resolution is best-effort — fall back to Unknown.
    }
    return map;
  }

  private async resolveRankingConfig(): Promise<{
    weights: typeof DEFAULT_WEIGHTS;
    minOnlineMinutes: number;
    minHandled: number;
  }> {
    try {
      const cfg = await this.settingsService.getSetting('omni_presence');
      const ranking = (cfg as Record<string, any>)?.ranking ?? {};
      return {
        weights: { ...DEFAULT_WEIGHTS, ...(ranking.weights ?? {}) },
        minOnlineMinutes:
          typeof ranking.minOnlineMinutes === 'number'
            ? ranking.minOnlineMinutes
            : 60,
        minHandled:
          typeof ranking.minHandled === 'number' ? ranking.minHandled : 20,
      };
    } catch {
      return { weights: DEFAULT_WEIGHTS, minOnlineMinutes: 60, minHandled: 20 };
    }
  }
}
