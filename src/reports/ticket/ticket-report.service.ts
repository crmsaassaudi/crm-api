import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClsService } from 'nestjs-cls';
import { Model, Types } from 'mongoose';
import {
  TicketSchemaClass,
  TicketSchemaDocument,
} from '../../tickets/infrastructure/persistence/document/entities/ticket.schema';
import { BaseReportFilterDto } from '../shared/dto/base-report-filter.dto';
import { ReportResponse } from '../shared/interfaces/report-response.interface';
import {
  getMongoDateFormat,
  parseReportDateRange,
} from '../shared/utils/report-date.util';
import { safePercent } from '../shared/utils/report-percentage.util';
import { buildReportResponse } from '../shared/utils/report-response.util';
import { GetTicketReportDto } from './dto/get-ticket-report.dto';
import {
  AgentWorkloadItem,
  BreakdownItem,
  CsatData,
  CsatDistributionItem,
  SlaComplianceData,
  TicketBreakdownData,
  TicketResolutionTimeData,
  TicketVolumeData,
} from './interfaces/ticket-report-types';

type DateContext = {
  from: Date;
  to: Date;
  timezone: string;
  requestedGranularity?: string;
  resolvedGranularity: 'day' | 'week' | 'month';
  warnings: string[];
};

@Injectable()
export class TicketReportService {
  constructor(
    @InjectModel(TicketSchemaClass.name)
    private readonly ticketModel: Model<TicketSchemaDocument>,
    private readonly cls: ClsService,
  ) {}

  // ── Report 1: Volume & Status ─────────────────────────────────────────────

  async getVolume(
    dto: GetTicketReportDto,
  ): Promise<ReportResponse<TicketVolumeData>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const format = getMongoDateFormat(context.resolvedGranularity);
    const match = {
      ...this.buildBaseMatch(dto),
      createdAt: { $gte: context.from, $lte: context.to },
    };

    const [facetResult] = await this.ticketModel
      .aggregate([
        { $match: match },
        {
          $facet: {
            trend: [
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format,
                      date: '$createdAt',
                      timezone: context.timezone,
                    },
                  },
                  count: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ],
            statusBreakdown: [
              {
                $lookup: {
                  from: 'ticketstatuses',
                  localField: 'statusId',
                  foreignField: '_id',
                  as: 'ticketStatus',
                },
              },
              {
                $unwind: {
                  path: '$ticketStatus',
                  preserveNullAndEmptyArrays: true,
                },
              },
              {
                $group: {
                  _id: {
                    $toLower: { $ifNull: ['$ticketStatus.apiName', 'open'] },
                  },
                  count: { $sum: 1 },
                },
              },
            ],
            total: [{ $count: 'count' }],
          },
        },
      ])
      .exec();

    const trendRows: any[] = facetResult?.trend ?? [];
    const statusRows: any[] = facetResult?.statusBreakdown ?? [];
    const total: number = facetResult?.total?.[0]?.count ?? 0;

    const statusMap = new Map<string, number>(
      statusRows.map((r: any) => [r._id, r.count]),
    );

    const data: TicketVolumeData = {
      trend: trendRows.map((r) => ({ date: r._id, count: r.count })),
      statusBreakdown: {
        open: statusMap.get('open') ?? 0,
        pending: statusMap.get('pending') ?? 0,
        resolved: statusMap.get('resolved') ?? 0,
        closed: statusMap.get('closed') ?? 0,
      },
      totalTickets: total,
    };

    return buildReportResponse({
      report: 'ticket_volume',
      dto,
      data,
      totalRecords: total,
      startedAt,
      requestedGranularity: context.requestedGranularity,
      resolvedGranularity: context.resolvedGranularity,
      warnings: context.warnings,
    });
  }

  // ── Report 2: SLA Compliance ──────────────────────────────────────────────

  async getSlaCompliance(
    dto: GetTicketReportDto,
  ): Promise<ReportResponse<SlaComplianceData>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const match = {
      ...this.buildBaseMatch(dto),
      createdAt: { $gte: context.from, $lte: context.to },
    };

    const [facetResult] = await this.ticketModel
      .aggregate([
        { $match: match },
        {
          $facet: {
            overall: [
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  breached: {
                    $sum: { $cond: [{ $eq: ['$isSlaBreached', true] }, 1, 0] },
                  },
                  frtOnTime: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            {
                              $ne: [
                                { $ifNull: ['$firstRespondedAt', null] },
                                null,
                              ],
                            },
                            {
                              $ne: [
                                { $ifNull: ['$firstResponseDueAt', null] },
                                null,
                              ],
                            },
                            {
                              $lte: [
                                '$firstRespondedAt',
                                '$firstResponseDueAt',
                              ],
                            },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  resolutionOnTime: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            { $ne: [{ $ifNull: ['$resolvedAt', null] }, null] },
                            {
                              $ne: [
                                { $ifNull: ['$resolutionDueAt', null] },
                                null,
                              ],
                            },
                            { $lte: ['$resolvedAt', '$resolutionDueAt'] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                },
              },
            ],
            byPriority: [
              {
                $group: {
                  _id: '$priority',
                  total: { $sum: 1 },
                  breached: {
                    $sum: { $cond: [{ $eq: ['$isSlaBreached', true] }, 1, 0] },
                  },
                },
              },
              { $sort: { total: -1 } },
            ],
          },
        },
      ])
      .exec();

    const o = facetResult?.overall?.[0] ?? {
      total: 0,
      breached: 0,
      frtOnTime: 0,
      resolutionOnTime: 0,
    };
    const byPriority: any[] = facetResult?.byPriority ?? [];

    const data: SlaComplianceData = {
      totalTickets: o.total,
      breachedCount: o.breached,
      breachRate: safePercent(o.breached, o.total),
      frtComplianceRate: safePercent(o.frtOnTime, o.total),
      resolutionComplianceRate: safePercent(o.resolutionOnTime, o.total),
      byPriority: byPriority.map((r: any) => ({
        priority: r._id ?? 'UNKNOWN',
        totalTickets: r.total,
        breachedCount: r.breached,
        breachRate: safePercent(r.breached, r.total),
      })),
    };

    return buildReportResponse({
      report: 'sla_compliance',
      dto,
      data,
      totalRecords: o.total,
      startedAt,
    });
  }

  // ── Report 3: Resolution Time ─────────────────────────────────────────────

  async getResolutionTime(
    dto: GetTicketReportDto,
  ): Promise<ReportResponse<TicketResolutionTimeData>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const match = {
      ...this.buildBaseMatch(dto),
      resolvedAt: { $gte: context.from, $lte: context.to },
    };

    const [facetResult] = await this.ticketModel
      .aggregate([
        { $match: match },
        {
          $facet: {
            overall: [
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  avgResolutionMs: {
                    $avg: { $subtract: ['$resolvedAt', '$createdAt'] },
                  },
                  avgFrtMs: {
                    $avg: {
                      $cond: [
                        {
                          $ne: [{ $ifNull: ['$firstRespondedAt', null] }, null],
                        },
                        { $subtract: ['$firstRespondedAt', '$createdAt'] },
                        null,
                      ],
                    },
                  },
                },
              },
            ],
            byPriority: [
              {
                $group: {
                  _id: '$priority',
                  count: { $sum: 1 },
                  avgResolutionMs: {
                    $avg: { $subtract: ['$resolvedAt', '$createdAt'] },
                  },
                  avgFrtMs: {
                    $avg: {
                      $cond: [
                        {
                          $ne: [{ $ifNull: ['$firstRespondedAt', null] }, null],
                        },
                        { $subtract: ['$firstRespondedAt', '$createdAt'] },
                        null,
                      ],
                    },
                  },
                },
              },
              { $sort: { count: -1 } },
            ],
          },
        },
      ])
      .exec();

    const o = facetResult?.overall?.[0] ?? {
      total: 0,
      avgResolutionMs: 0,
      avgFrtMs: 0,
    };
    const byPriority: any[] = facetResult?.byPriority ?? [];

    const data: TicketResolutionTimeData = {
      avgResolutionMs: Math.round(o.avgResolutionMs ?? 0),
      avgResolutionFormatted: this.formatDuration(o.avgResolutionMs ?? 0),
      avgFrtMs: Math.round(o.avgFrtMs ?? 0),
      avgFrtFormatted: this.formatDuration(o.avgFrtMs ?? 0),
      totalResolved: o.total,
      byPriority: byPriority.map((r: any) => ({
        priority: r._id ?? 'UNKNOWN',
        avgResolutionMs: Math.round(r.avgResolutionMs ?? 0),
        avgResolutionFormatted: this.formatDuration(r.avgResolutionMs ?? 0),
        avgFrtMs: Math.round(r.avgFrtMs ?? 0),
        avgFrtFormatted: this.formatDuration(r.avgFrtMs ?? 0),
        count: r.count,
      })),
    };

    return buildReportResponse({
      report: 'resolution_time',
      dto,
      data,
      totalRecords: o.total,
      startedAt,
    });
  }

  // ── Report 4: Agent Workload ──────────────────────────────────────────────

  async getAgentWorkload(
    dto: GetTicketReportDto,
  ): Promise<ReportResponse<AgentWorkloadItem[]>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const match = {
      ...this.buildBaseMatch(dto),
      createdAt: { $gte: context.from, $lte: context.to },
    };

    const rows = await this.ticketModel
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: '$ownerId',
            totalTickets: { $sum: 1 },
            resolvedTickets: {
              $sum: {
                $cond: [
                  { $ne: [{ $ifNull: ['$resolvedAt', null] }, null] },
                  1,
                  0,
                ],
              },
            },
            avgResolutionMs: {
              $avg: {
                $cond: [
                  { $ne: [{ $ifNull: ['$resolvedAt', null] }, null] },
                  { $subtract: ['$resolvedAt', '$createdAt'] },
                  null,
                ],
              },
            },
            breachCount: {
              $sum: { $cond: [{ $eq: ['$isSlaBreached', true] }, 1, 0] },
            },
            avgCsat: { $avg: { $ifNull: ['$csatScore', null] } },
          },
        },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'agent',
          },
        },
        { $unwind: { path: '$agent', preserveNullAndEmptyArrays: true } },
        { $sort: { totalTickets: -1 } },
      ])
      .exec();

    const data: AgentWorkloadItem[] = rows.map((row) => {
      const agentName = [row.agent?.firstName, row.agent?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      return {
        agentId: row._id?.toString() ?? null,
        agentName: agentName || row.agent?.email || 'Unassigned',
        agentEmail: row.agent?.email ?? '',
        totalTickets: row.totalTickets,
        resolvedTickets: row.resolvedTickets,
        avgResolutionMs: Math.round(row.avgResolutionMs ?? 0),
        avgResolutionFormatted: this.formatDuration(row.avgResolutionMs ?? 0),
        breachCount: row.breachCount,
        avgCsat: row.avgCsat != null ? Math.round(row.avgCsat * 10) / 10 : null,
      };
    });

    return buildReportResponse({
      report: 'agent_workload',
      dto,
      data,
      totalRecords: data.reduce((s, d) => s + d.totalTickets, 0),
      startedAt,
    });
  }

  // ── Report 5: Breakdown (Source / Type / Priority) ────────────────────────

  async getBreakdown(
    dto: GetTicketReportDto,
  ): Promise<ReportResponse<TicketBreakdownData>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const match = {
      ...this.buildBaseMatch(dto),
      createdAt: { $gte: context.from, $lte: context.to },
    };

    const [facetResult] = await this.ticketModel
      .aggregate([
        { $match: match },
        {
          $facet: {
            total: [{ $count: 'count' }],
            bySource: [
              { $group: { _id: '$sourceId', count: { $sum: 1 } } },
              {
                $lookup: {
                  from: 'ticketsources',
                  localField: '_id',
                  foreignField: '_id',
                  as: 'source',
                },
              },
              {
                $unwind: { path: '$source', preserveNullAndEmptyArrays: true },
              },
              { $sort: { count: -1 } },
            ],
            byType: [
              { $group: { _id: '$typeId', count: { $sum: 1 } } },
              {
                $lookup: {
                  from: 'tickettypes',
                  localField: '_id',
                  foreignField: '_id',
                  as: 'type',
                },
              },
              { $unwind: { path: '$type', preserveNullAndEmptyArrays: true } },
              { $sort: { count: -1 } },
            ],
            byPriority: [
              { $group: { _id: '$priority', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
          },
        },
      ])
      .exec();

    const total: number = facetResult?.total?.[0]?.count ?? 0;
    const toBreakdownItem = (row: any, name: string): BreakdownItem => ({
      id: row._id?.toString() ?? null,
      name,
      count: row.count,
      percentage: safePercent(row.count, total),
    });

    const data: TicketBreakdownData = {
      bySource: (facetResult?.bySource ?? []).map((r: any) =>
        toBreakdownItem(r, r.source?.name ?? 'Unknown'),
      ),
      byType: (facetResult?.byType ?? []).map((r: any) =>
        toBreakdownItem(r, r.type?.name ?? 'Unknown'),
      ),
      byPriority: (facetResult?.byPriority ?? []).map((r: any) =>
        toBreakdownItem(r, r._id ?? 'Unknown'),
      ),
    };

    return buildReportResponse({
      report: 'ticket_breakdown',
      dto,
      data,
      totalRecords: total,
      startedAt,
    });
  }

  // ── Report 6: CSAT ────────────────────────────────────────────────────────

  async getCsat(dto: GetTicketReportDto): Promise<ReportResponse<CsatData>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const format = getMongoDateFormat(context.resolvedGranularity);
    const match = {
      ...this.buildBaseMatch(dto),
      csatScore: { $ne: null },
      resolvedAt: { $gte: context.from, $lte: context.to },
    };

    const [facetResult] = await this.ticketModel
      .aggregate([
        { $match: match },
        {
          $facet: {
            overall: [
              {
                $group: {
                  _id: null,
                  avgScore: { $avg: '$csatScore' },
                  count: { $sum: 1 },
                },
              },
            ],
            distribution: [
              { $group: { _id: '$csatScore', count: { $sum: 1 } } },
              { $sort: { _id: 1 } },
            ],
            trend: [
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format,
                      date: '$resolvedAt',
                      timezone: context.timezone,
                    },
                  },
                  avgScore: { $avg: '$csatScore' },
                  count: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ],
          },
        },
      ])
      .exec();

    const o = facetResult?.overall?.[0] ?? { avgScore: 0, count: 0 };
    const totalRatings = o.count;
    const distribution = (facetResult?.distribution ?? []).map((r: any) => ({
      score: r._id,
      count: r.count,
      percentage: safePercent(r.count, totalRatings),
    }));

    // Ensure all 5 scores appear even if count=0
    const distMap = new Map<number, CsatDistributionItem>(
      distribution.map((d: any) => [
        d.score as number,
        d as CsatDistributionItem,
      ]),
    );
    const fullDistribution: CsatDistributionItem[] = [1, 2, 3, 4, 5].map(
      (score) => distMap.get(score) ?? { score, count: 0, percentage: 0 },
    );

    const data: CsatData = {
      avgScore: o.avgScore != null ? Math.round(o.avgScore * 10) / 10 : 0,
      totalRatings,
      distribution: fullDistribution,
      trend: (facetResult?.trend ?? []).map((r: any) => ({
        date: r._id,
        avgScore: Math.round((r.avgScore ?? 0) * 10) / 10,
        count: r.count,
      })),
    };

    return buildReportResponse({
      report: 'ticket_csat',
      dto,
      data,
      totalRecords: totalRatings,
      startedAt,
      requestedGranularity: context.requestedGranularity,
      resolvedGranularity: context.resolvedGranularity,
      warnings: context.warnings,
    });
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  private buildBaseMatch(dto: GetTicketReportDto): Record<string, any> {
    const match: Record<string, any> = {
      tenantId: this.tenantObjectId(),
      deletedAt: { $exists: false },
    };
    if (dto.ownerId) match.ownerId = new Types.ObjectId(dto.ownerId);
    if (dto.statusId) match.statusId = new Types.ObjectId(dto.statusId);
    if (dto.typeId) match.typeId = new Types.ObjectId(dto.typeId);
    if (dto.priority) match.priority = dto.priority;
    if (dto.groupId) match.groupId = new Types.ObjectId(dto.groupId);
    return match;
  }

  private tenantObjectId(): Types.ObjectId {
    const tenantId = this.cls.get('tenantId');
    return new Types.ObjectId(tenantId);
  }

  private resolveDateContext(dto: BaseReportFilterDto): DateContext {
    const { from, to } = parseReportDateRange(dto.fromDate, dto.toDate);
    const timezone = dto.timezone || 'UTC';
    const resolvedGranularity = BaseReportFilterDto.resolveGranularity(
      from,
      to,
      dto.granularity,
    );
    const warnings: string[] = [];
    if (dto.granularity && dto.granularity !== resolvedGranularity) {
      warnings.push(
        `Granularity auto-adjusted from "${dto.granularity}" to "${resolvedGranularity}" for the selected date range.`,
      );
    }
    return {
      from,
      to,
      timezone,
      requestedGranularity: dto.granularity,
      resolvedGranularity,
      warnings,
    };
  }

  private formatDuration(ms: number): string {
    if (!ms || ms <= 0) return '0m';
    const totalMinutes = Math.floor(ms / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return `${minutes}m`;
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }
}
