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
import { buildCrmReportVisibilityFilter } from '../shared/utils/report-visibility-filter.util';
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
import { reportAggregate } from '../shared/utils/report-aggregate.util';
import { COLLECTIONS } from '../../common/persistence/collections';

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

  // Report 1: Volume & Status

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

    const [facetResult] = await reportAggregate(this.ticketModel, [
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
                from: COLLECTIONS.ticketStatuses,
                localField: 'statusId',
                foreignField: '_id',
                as: 'ticketStatus',
              },
            },
            { $unwind: '$ticketStatus' },
            {
              $group: {
                _id: '$ticketStatus._id',
                label: { $first: '$ticketStatus.label' },
                apiName: { $first: '$ticketStatus.apiName' },
                color: { $first: '$ticketStatus.color' },
                sortOrder: { $first: '$ticketStatus.sortOrder' },
                terminalKind: { $first: '$ticketStatus.terminalKind' },
                count: { $sum: 1 },
              },
            },
            { $sort: { sortOrder: 1 } },
          ],
          totals: [
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                reopened: {
                  $sum: {
                    $cond: [
                      { $gt: [{ $ifNull: ['$reopenCount', 0] }, 0] },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    ]).exec();

    const trendRows: any[] = facetResult?.trend ?? [];
    const statusRows: any[] = facetResult?.statusBreakdown ?? [];
    const totals = facetResult?.totals?.[0] ?? { count: 0, reopened: 0 };
    const total: number = totals.count;

    // One entry per status the tenant actually configured.
    //
    // This used to collapse into four hard-coded buckets keyed by apiName —
    // open/pending/resolved/closed — which no seeded tenant matches ("new",
    // "on_hold") and no tenant that renamed a status matches at all. Those
    // tickets were counted in the total and shown in no bucket.
    const data: TicketVolumeData = {
      trend: trendRows.map((r) => ({ date: r._id, count: r.count })),
      statusBreakdown: statusRows.map((row: any) => ({
        statusId: String(row._id),
        label: row.label,
        apiName: row.apiName,
        color: row.color ?? null,
        terminalKind: row.terminalKind ?? null,
        count: row.count,
        percentage: safePercent(row.count, total),
      })),
      openTickets: statusRows
        .filter((row: any) => !row.terminalKind)
        .reduce((sum: number, row: any) => sum + row.count, 0),
      reopenedTickets: totals.reopened,
      reopenRate: safePercent(totals.reopened, total),
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

  // Report 2: SLA Compliance

  async getSlaCompliance(
    dto: GetTicketReportDto,
  ): Promise<ReportResponse<SlaComplianceData>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const match = {
      ...this.buildBaseMatch(dto),
      createdAt: { $gte: context.from, $lte: context.to },
    };

    const [facetResult] = await reportAggregate(this.ticketModel, [
      { $match: match },
      {
        $facet: {
          overall: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                // A ticket is "measured" once an SLA policy attached a
                // deadline to it. Dividing by every ticket instead made a
                // tenant with partial policy coverage look non-compliant.
                measured: {
                  $sum: {
                    $cond: [
                      { $ne: [{ $ifNull: ['$slaPolicyId', null] }, null] },
                      1,
                      0,
                    ],
                  },
                },
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
                            $lte: ['$firstRespondedAt', '$firstResponseDueAt'],
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
    ]).exec();

    const o = facetResult?.overall?.[0] ?? {
      total: 0,
      measured: 0,
      breached: 0,
      frtOnTime: 0,
      resolutionOnTime: 0,
    };
    const byPriority: any[] = facetResult?.byPriority ?? [];

    const data: SlaComplianceData = {
      totalTickets: o.total,
      measuredTickets: o.measured,
      breachedCount: o.breached,
      breachRate: safePercent(o.breached, o.measured),
      frtComplianceRate: safePercent(o.frtOnTime, o.measured),
      resolutionComplianceRate: safePercent(o.resolutionOnTime, o.measured),
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

  // Report 3: Resolution Time

  async getResolutionTime(
    dto: GetTicketReportDto,
  ): Promise<ReportResponse<TicketResolutionTimeData>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const match = {
      ...this.buildBaseMatch(dto),
      resolvedAt: { $gte: context.from, $lte: context.to },
    };

    const [facetResult] = await reportAggregate(this.ticketModel, [
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
    ]).exec();

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

  // Report 4: Agent Workload

  async getAgentWorkload(
    dto: GetTicketReportDto,
  ): Promise<ReportResponse<AgentWorkloadItem[]>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const match = {
      ...this.buildBaseMatch(dto),
      createdAt: { $gte: context.from, $lte: context.to },
    };

    const rows = await reportAggregate(this.ticketModel, [
      { $match: match },
      {
        $group: {
          _id: '$ownerId',
          totalTickets: { $sum: 1 },
          // Open work is what a supervisor rebalances on; lifetime totals are
          // not actionable. `closedAt` is the terminal marker.
          openTickets: {
            $sum: {
              $cond: [{ $ifNull: ['$closedAt', false] }, 0, 1],
            },
          },
          resolvedTickets: {
            $sum: {
              $cond: [
                { $ne: [{ $ifNull: ['$resolvedAt', null] }, null] },
                1,
                0,
              ],
            },
          },
          reopenedTickets: {
            $sum: {
              $cond: [{ $gt: [{ $ifNull: ['$reopenCount', 0] }, 0] }, 1, 0],
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
          from: COLLECTIONS.users,
          localField: '_id',
          foreignField: '_id',
          as: 'agent',
        },
      },
      { $unwind: { path: '$agent', preserveNullAndEmptyArrays: true } },
      { $sort: { totalTickets: -1 } },
    ]).exec();

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
        openTickets: row.openTickets,
        resolvedTickets: row.resolvedTickets,
        reopenedTickets: row.reopenedTickets,
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

  // Report 5: Breakdown (Source / Type / Priority)

  async getBreakdown(
    dto: GetTicketReportDto,
  ): Promise<ReportResponse<TicketBreakdownData>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const match = {
      ...this.buildBaseMatch(dto),
      createdAt: { $gte: context.from, $lte: context.to },
    };

    const [facetResult] = await reportAggregate(this.ticketModel, [
      { $match: match },
      {
        $facet: {
          total: [{ $count: 'count' }],
          bySource: [
            { $group: { _id: '$sourceId', count: { $sum: 1 } } },
            {
              $lookup: {
                from: COLLECTIONS.ticketSources,
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
                from: COLLECTIONS.ticketTypes,
                localField: '_id',
                foreignField: '_id',
                as: 'type',
              },
            },
            { $unwind: { path: '$type', preserveNullAndEmptyArrays: true } },
            { $sort: { count: -1 } },
          ],
          byCategory: [
            {
              $group: {
                _id: { $ifNull: [{ $first: '$categoryPath' }, null] },
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1 } },
            { $limit: 50 },
          ],
          byChannel: [
            {
              $group: {
                _id: { $ifNull: ['$channel', null] },
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1 } },
            { $limit: 50 },
          ],
          byPriority: [
            { $group: { _id: '$priority', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
          ],
        },
      },
    ]).exec();

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
      // §7.4 asked for these two and neither existed. Category is the root node
      // of `categoryPath`; the label is resolved client-side against the tenant's
      // category tree, which is the only place the node names live.
      byCategory: (facetResult?.byCategory ?? []).map((r: any) =>
        toBreakdownItem(r, r._id ?? 'Uncategorised'),
      ),
      byChannel: (facetResult?.byChannel ?? []).map((r: any) =>
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

  // Report 6: CSAT

  async getCsat(dto: GetTicketReportDto): Promise<ReportResponse<CsatData>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const format = getMongoDateFormat(context.resolvedGranularity);
    const match = {
      ...this.buildBaseMatch(dto),
      csatScore: { $ne: null },
      resolvedAt: { $gte: context.from, $lte: context.to },
    };

    const [facetResult] = await reportAggregate(this.ticketModel, [
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
    ]).exec();

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

  // Private Helpers

  private buildBaseMatch(dto: GetTicketReportDto): Record<string, any> {
    const match: Record<string, any> = {
      tenantId: this.tenantObjectId(),
      // `null` matches both an absent field and an explicit null, which is what
      // the repository's live-record predicate uses. `$exists: false` did not
      // match a restored record, whose `deletedAt` is unset back to null.
      deletedAt: null,
      ...buildCrmReportVisibilityFilter(this.cls, 'Ticket'),
    };
    if (dto.ownerId) match.ownerId = new Types.ObjectId(dto.ownerId);
    if (dto.statusId) match.statusId = new Types.ObjectId(dto.statusId);
    if (dto.typeId) match.typeId = new Types.ObjectId(dto.typeId);
    if (dto.priority) match.priority = dto.priority;
    if (dto.groupId) match.groupId = new Types.ObjectId(dto.groupId);
    return match;
  }

  private tenantObjectId(): Types.ObjectId {
    const tenantId: string = this.cls.get('tenantId');
    return new Types.ObjectId(tenantId);
  }

  private resolveDateContext(dto: BaseReportFilterDto): DateContext {
    const { from, to } = parseReportDateRange(dto.fromDate, dto.toDate);
    const timezone = dto.timezone ?? 'UTC';
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
