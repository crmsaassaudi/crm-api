import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClsService } from 'nestjs-cls';
import { Model, Types } from 'mongoose';
import {
  OmniConversationSchemaClass,
  OmniConversationDocument,
} from '../../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';
import {
  OmniMessageSchemaClass,
  OmniMessageDocument,
} from '../../omni-inbound/infrastructure/persistence/document/entities/omni-message.schema';
import { BaseReportFilterDto } from '../shared/dto/base-report-filter.dto';
import { ReportResponse } from '../shared/interfaces/report-response.interface';
import {
  getMongoDateFormat,
  mergeGrowthBuckets,
  parseReportDateRange,
} from '../shared/utils/report-date.util';
import { safePercent } from '../shared/utils/report-percentage.util';
import { buildReportResponse } from '../shared/utils/report-response.util';
import { GetOmniReportDto } from './dto/get-omni-report.dto';
import {
  AgentPerformanceItem,
  BotPerformanceData,
  ChannelDistributionItem,
  ConversationVolumePoint,
  MessageVolumeData,
  PeakHoursCell,
  ReopenRateData,
  ResolutionSummaryData,
  ResponseTimeData,
  TagAnalyticsItem,
} from './interfaces/omni-report-types';

type DateContext = {
  from: Date;
  to: Date;
  timezone: string;
  requestedGranularity?: string;
  resolvedGranularity: 'day' | 'week' | 'month';
  warnings: string[];
};

@Injectable()
export class OmniReportService {
  constructor(
    @InjectModel(OmniConversationSchemaClass.name)
    private readonly conversationModel: Model<OmniConversationDocument>,
    @InjectModel(OmniMessageSchemaClass.name)
    private readonly messageModel: Model<OmniMessageDocument>,
    private readonly cls: ClsService,
  ) {}

  // ── Report 1: Conversation Volume Trend ───────────────────────────

  async getConversationVolume(
    dto: GetOmniReportDto,
  ): Promise<ReportResponse<ConversationVolumePoint[]>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const format = getMongoDateFormat(context.resolvedGranularity);
    const baseMatch = this.buildBaseMatch(dto);

    const [facetResult] = await this.conversationModel
      .aggregate([
        {
          $match: {
            ...baseMatch,
            $or: [
              { createdAt: { $gte: context.from, $lte: context.to } },
              { resolvedAt: { $gte: context.from, $lte: context.to } },
            ],
          },
        },
        {
          $facet: {
            created: [
              {
                $match: {
                  createdAt: { $gte: context.from, $lte: context.to },
                },
              },
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
            ],
            resolved: [
              {
                $match: {
                  resolvedAt: { $gte: context.from, $lte: context.to },
                },
              },
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format,
                      date: '$resolvedAt',
                      timezone: context.timezone,
                    },
                  },
                  count: { $sum: 1 },
                },
              },
            ],
          },
        },
      ])
      .exec();

    const created = facetResult?.created ?? [];
    const resolved = facetResult?.resolved ?? [];
    const merged = mergeGrowthBuckets(
      context.from,
      context.to,
      context.resolvedGranularity,
      created,
      resolved,
    );

    const data: ConversationVolumePoint[] = merged.map((bucket) => ({
      date: bucket.date,
      createdCount: bucket.createdCount,
      resolvedCount: bucket.deletedCount, // mergeGrowthBuckets uses "deleted" slot
      netActive: bucket.netGrowth,
    }));

    return buildReportResponse({
      report: 'conversation_volume',
      dto,
      data,
      totalRecords: data.reduce(
        (sum, item) => sum + item.createdCount + item.resolvedCount,
        0,
      ),
      startedAt,
      requestedGranularity: context.requestedGranularity,
      resolvedGranularity: context.resolvedGranularity,
      warnings: context.warnings,
    });
  }

  // ── Report 2: Channel Distribution ────────────────────────────────

  async getChannelDistribution(
    dto: GetOmniReportDto,
  ): Promise<ReportResponse<ChannelDistributionItem[]>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const match = {
      ...this.buildBaseMatch(dto),
      createdAt: { $gte: context.from, $lte: context.to },
    };

    const [facetResult] = await this.conversationModel
      .aggregate([
        { $match: match },
        {
          $facet: {
            total: [{ $count: 'count' }],
            rows: [
              { $group: { _id: '$channelType', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
          },
        },
      ])
      .exec();

    const total: number = facetResult?.total?.[0]?.count ?? 0;
    const rows: any[] = facetResult?.rows ?? [];
    const data = rows.map((row) => ({
      channelType: row._id ?? 'unknown',
      count: row.count,
      percentage: safePercent(row.count, total),
    }));

    return buildReportResponse({
      report: 'channel_distribution',
      dto,
      data,
      totalRecords: total,
      startedAt,
    });
  }

  // ── Report 3: Agent Performance ───────────────────────────────────

  async getAgentPerformance(
    dto: GetOmniReportDto,
  ): Promise<ReportResponse<AgentPerformanceItem[]>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const match = {
      ...this.buildBaseMatch(dto),
      status: { $in: ['resolved', 'closed'] },
      resolvedAt: { $gte: context.from, $lte: context.to },
    };

    const rows = await this.conversationModel
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: '$assignedAgentId',
            totalConversations: { $sum: 1 },
            avgResolutionMs: {
              $avg: { $subtract: ['$resolvedAt', '$createdAt'] },
            },
            frtBreachCount: {
              $sum: { $cond: [{ $eq: ['$frtBreached', true] }, 1, 0] },
            },
            resolutionBreachCount: {
              $sum: {
                $cond: [{ $eq: ['$resolutionBreached', true] }, 1, 0],
              },
            },
            avgMessageCount: { $avg: '$messageCount' },
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
        { $sort: { totalConversations: -1 } },
      ])
      .exec();

    const data: AgentPerformanceItem[] = rows.map((row) => {
      const agentName = [row.agent?.firstName, row.agent?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();

      return {
        agentId: row._id?.toString?.() ?? null,
        agentName: agentName || 'Unassigned',
        agentEmail: row.agent?.email ?? '',
        totalConversations: row.totalConversations,
        avgResolutionMs: Math.round(row.avgResolutionMs ?? 0),
        avgResolutionFormatted: this.formatDuration(row.avgResolutionMs ?? 0),
        frtBreachCount: row.frtBreachCount,
        frtBreachRate: safePercent(row.frtBreachCount, row.totalConversations),
        resolutionBreachCount: row.resolutionBreachCount,
        resolutionBreachRate: safePercent(
          row.resolutionBreachCount,
          row.totalConversations,
        ),
        avgMessageCount: Math.round(row.avgMessageCount ?? 0),
      };
    });

    return buildReportResponse({
      report: 'agent_performance',
      dto,
      data,
      totalRecords: data.reduce(
        (sum, item) => sum + item.totalConversations,
        0,
      ),
      startedAt,
    });
  }

  // ── Report 4: Response Time Analytics ─────────────────────────────

  async getResponseTime(
    dto: GetOmniReportDto,
  ): Promise<ReportResponse<ResponseTimeData>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const match = {
      ...this.buildBaseMatch(dto),
      status: { $in: ['resolved', 'closed'] },
      resolvedAt: { $gte: context.from, $lte: context.to },
    };

    const rows = await this.conversationModel
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            avgResolutionMs: {
              $avg: { $subtract: ['$resolvedAt', '$createdAt'] },
            },
            frtBreachedCount: {
              $sum: { $cond: [{ $eq: ['$frtBreached', true] }, 1, 0] },
            },
            resolutionBreachedCount: {
              $sum: {
                $cond: [{ $eq: ['$resolutionBreached', true] }, 1, 0],
              },
            },
          },
        },
      ])
      .exec();

    const row = rows[0] ?? {
      total: 0,
      avgResolutionMs: 0,
      frtBreachedCount: 0,
      resolutionBreachedCount: 0,
    };

    const data: ResponseTimeData = {
      totalConversations: row.total,
      avgResolutionMs: Math.round(row.avgResolutionMs ?? 0),
      avgResolutionFormatted: this.formatDuration(row.avgResolutionMs ?? 0),
      frtBreachedCount: row.frtBreachedCount,
      frtComplianceRate: safePercent(
        row.total - row.frtBreachedCount,
        row.total,
      ),
      resolutionBreachedCount: row.resolutionBreachedCount,
      resolutionComplianceRate: safePercent(
        row.total - row.resolutionBreachedCount,
        row.total,
      ),
    };

    return buildReportResponse({
      report: 'response_time',
      dto,
      data,
      totalRecords: row.total,
      startedAt,
    });
  }

  // ── Report 5: Resolution Summary ──────────────────────────────────

  async getResolutionSummary(
    dto: GetOmniReportDto,
  ): Promise<ReportResponse<ResolutionSummaryData>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const baseMatch = {
      ...this.buildBaseMatch(dto),
      createdAt: { $gte: context.from, $lte: context.to },
    };

    const [facetResult] = await this.conversationModel
      .aggregate([
        { $match: baseMatch },
        {
          $facet: {
            statusBreakdown: [
              { $group: { _id: '$status', count: { $sum: 1 } } },
            ],
            resolveSource: [
              {
                $match: {
                  status: { $in: ['resolved', 'closed'] },
                  resolveSource: { $ne: null },
                },
              },
              { $group: { _id: '$resolveSource', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
            resolveReason: [
              {
                $match: {
                  status: { $in: ['resolved', 'closed'] },
                  resolveReason: { $ne: null },
                },
              },
              { $group: { _id: '$resolveReason', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
          },
        },
      ])
      .exec();

    const statusMap = new Map<string, number>(
      (facetResult?.statusBreakdown ?? []).map((row: any) => [
        row._id,
        row.count,
      ]),
    );

    const totalResolved =
      (statusMap.get('resolved') ?? 0) + (statusMap.get('closed') ?? 0);

    const data: ResolutionSummaryData = {
      statusBreakdown: {
        open: statusMap.get('open') ?? 0,
        pending: statusMap.get('pending') ?? 0,
        resolved: statusMap.get('resolved') ?? 0,
        closed: statusMap.get('closed') ?? 0,
      },
      resolveSourceDistribution: (facetResult?.resolveSource ?? []).map(
        (row: any) => ({
          source: row._id ?? 'unknown',
          count: row.count,
          percentage: safePercent(row.count, totalResolved),
        }),
      ),
      resolveReasonDistribution: (facetResult?.resolveReason ?? []).map(
        (row: any) => ({
          reason: row._id ?? 'unknown',
          count: row.count,
          percentage: safePercent(row.count, totalResolved),
        }),
      ),
    };

    const totalRecords =
      data.statusBreakdown.open +
      data.statusBreakdown.pending +
      data.statusBreakdown.resolved +
      data.statusBreakdown.closed;

    return buildReportResponse({
      report: 'resolution_summary',
      dto,
      data,
      totalRecords,
      startedAt,
    });
  }

  // ── Report 6: Message Volume by Type ──────────────────────────────

  async getMessageVolume(
    dto: GetOmniReportDto,
  ): Promise<ReportResponse<MessageVolumeData>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const baseMatch: any = {
      tenantId: this.tenantObjectId(),
      createdAt: { $gte: context.from, $lte: context.to },
    };

    const [facetResult] = await this.messageModel
      .aggregate([
        { $match: baseMatch },
        {
          $facet: {
            total: [{ $count: 'count' }],
            byType: [
              { $group: { _id: '$messageType', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
            byDirection: [
              { $group: { _id: '$direction', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
            bySenderType: [
              { $group: { _id: '$senderType', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
          },
        },
      ])
      .exec();

    const total: number = facetResult?.total?.[0]?.count ?? 0;

    const data: MessageVolumeData = {
      byType: (facetResult?.byType ?? []).map((row: any) => ({
        type: row._id ?? 'unknown',
        count: row.count,
        percentage: safePercent(row.count, total),
      })),
      byDirection: (facetResult?.byDirection ?? []).map((row: any) => ({
        direction: row._id ?? 'unknown',
        count: row.count,
        percentage: safePercent(row.count, total),
      })),
      bySenderType: (facetResult?.bySenderType ?? []).map((row: any) => ({
        senderType: row._id ?? 'unknown',
        count: row.count,
        percentage: safePercent(row.count, total),
      })),
    };

    return buildReportResponse({
      report: 'message_volume',
      dto,
      data,
      totalRecords: total,
      startedAt,
    });
  }

  // ── Report 7: Bot Performance ─────────────────────────────────────

  async getBotPerformance(
    dto: GetOmniReportDto,
  ): Promise<ReportResponse<BotPerformanceData>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const match = {
      ...this.buildBaseMatch(dto),
      createdAt: { $gte: context.from, $lte: context.to },
      'bot.enabled': true,
    };

    const rows = await this.conversationModel
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            botResolved: {
              $sum: {
                $cond: [{ $eq: ['$resolveSource', 'bot'] }, 1, 0],
              },
            },
            botHandoff: {
              $sum: {
                $cond: [{ $eq: ['$bot.status', 'handoff'] }, 1, 0],
              },
            },
            avgMessageCount: { $avg: '$messageCount' },
          },
        },
      ])
      .exec();

    const row = rows[0] ?? {
      total: 0,
      botResolved: 0,
      botHandoff: 0,
      avgMessageCount: 0,
    };

    const data: BotPerformanceData = {
      totalBotConversations: row.total,
      botResolvedCount: row.botResolved,
      botResolvedRate: safePercent(row.botResolved, row.total),
      botHandoffCount: row.botHandoff,
      botHandoffRate: safePercent(row.botHandoff, row.total),
      avgBotMessages: Math.round(row.avgMessageCount ?? 0),
    };

    return buildReportResponse({
      report: 'bot_performance',
      dto,
      data,
      totalRecords: row.total,
      startedAt,
    });
  }

  // ── Report 8: Peak Hours Heatmap ──────────────────────────────────

  async getPeakHours(
    dto: GetOmniReportDto,
  ): Promise<ReportResponse<PeakHoursCell[]>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const match = {
      ...this.buildBaseMatch(dto),
      createdAt: { $gte: context.from, $lte: context.to },
    };

    const rows = await this.conversationModel
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              dayOfWeek: {
                $dayOfWeek: {
                  date: '$createdAt',
                  timezone: context.timezone,
                },
              },
              hour: {
                $hour: { date: '$createdAt', timezone: context.timezone },
              },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.dayOfWeek': 1, '_id.hour': 1 } },
      ])
      .exec();

    // MongoDB $dayOfWeek: 1=Sunday … 7=Saturday → convert to 0=Sunday … 6=Saturday
    const data: PeakHoursCell[] = rows.map((row) => ({
      dayOfWeek: (row._id.dayOfWeek - 1) % 7,
      hour: row._id.hour,
      count: row.count,
    }));

    return buildReportResponse({
      report: 'peak_hours',
      dto,
      data,
      totalRecords: data.reduce((sum, cell) => sum + cell.count, 0),
      startedAt,
    });
  }

  // ── Report 9: Tag Analytics ───────────────────────────────────────

  async getTagAnalytics(
    dto: GetOmniReportDto,
  ): Promise<ReportResponse<TagAnalyticsItem[]>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const match = {
      ...this.buildBaseMatch(dto),
      createdAt: { $gte: context.from, $lte: context.to },
      'tags.0': { $exists: true },
    };

    const [facetResult] = await this.conversationModel
      .aggregate([
        { $match: match },
        { $unwind: '$tags' },
        {
          $facet: {
            total: [{ $count: 'count' }],
            rows: [
              { $group: { _id: '$tags', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 50 },
              {
                $addFields: {
                  tagObjectId: {
                    $convert: {
                      input: '$_id',
                      to: 'objectId',
                      onError: null,
                      onNull: null,
                    },
                  },
                },
              },
              {
                $lookup: {
                  from: 'tags',
                  localField: 'tagObjectId',
                  foreignField: '_id',
                  as: 'tagDoc',
                },
              },
              {
                $addFields: {
                  tagName: {
                    $ifNull: [{ $arrayElemAt: ['$tagDoc.name', 0] }, '$_id'],
                  },
                  tagColor: { $arrayElemAt: ['$tagDoc.color', 0] },
                },
              },
            ],
          },
        },
      ])
      .exec();

    const total: number = facetResult?.total?.[0]?.count ?? 0;
    const data: TagAnalyticsItem[] = (facetResult?.rows ?? []).map(
      (row: any) => ({
        tag: row.tagName ?? row._id ?? 'unknown',
        tagId: row._id,
        color: row.tagColor,
        count: row.count,
        percentage: safePercent(row.count, total),
      }),
    );

    return buildReportResponse({
      report: 'tag_analytics',
      dto,
      data,
      totalRecords: total,
      startedAt,
    });
  }

  // ── Report 10: Reopen Rate ────────────────────────────────────────

  async getReopenRate(
    dto: GetOmniReportDto,
  ): Promise<ReportResponse<ReopenRateData>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const format = getMongoDateFormat(context.resolvedGranularity);
    const match = {
      ...this.buildBaseMatch(dto),
      resolvedAt: { $gte: context.from, $lte: context.to },
      status: { $in: ['resolved', 'closed'] },
    };

    const [summary, trendRows] = await Promise.all([
      this.conversationModel
        .aggregate([
          { $match: match },
          {
            $group: {
              _id: null,
              totalResolved: { $sum: 1 },
              reopenedCount: {
                $sum: { $cond: [{ $gt: ['$reopenCount', 0] }, 1, 0] },
              },
            },
          },
        ])
        .exec(),
      this.conversationModel
        .aggregate([
          { $match: match },
          {
            $group: {
              _id: {
                $dateToString: {
                  format,
                  date: '$resolvedAt',
                  timezone: context.timezone,
                },
              },
              resolvedCount: { $sum: 1 },
              reopenedCount: {
                $sum: { $cond: [{ $gt: ['$reopenCount', 0] }, 1, 0] },
              },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .exec(),
    ]);

    const totals = summary[0] ?? { totalResolved: 0, reopenedCount: 0 };

    const data: ReopenRateData = {
      totalResolved: totals.totalResolved,
      reopenedCount: totals.reopenedCount,
      reopenRate: safePercent(totals.reopenedCount, totals.totalResolved),
      trend: trendRows.map((row) => ({
        date: row._id,
        reopenedCount: row.reopenedCount,
        resolvedCount: row.resolvedCount,
      })),
    };

    return buildReportResponse({
      report: 'reopen_rate',
      dto,
      data,
      totalRecords: totals.totalResolved,
      startedAt,
      requestedGranularity: context.requestedGranularity,
      resolvedGranularity: context.resolvedGranularity,
      warnings: context.warnings,
    });
  }

  // ── Private Helpers ───────────────────────────────────────────────

  private buildBaseMatch(dto: GetOmniReportDto): Record<string, any> {
    const match: Record<string, any> = {
      tenantId: this.tenantObjectId(),
    };

    if (dto.channelType) {
      match.channelType = dto.channelType;
    }

    if (dto.agentId) {
      match.assignedAgentId = new Types.ObjectId(dto.agentId);
    }

    return match;
  }

  private tenantObjectId(): Types.ObjectId {
    const tenantId = this.cls.get('tenantId');
    return new Types.ObjectId(String(tenantId));
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
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }
}
