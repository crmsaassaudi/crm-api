import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClsService } from 'nestjs-cls';
import { Model, Types } from 'mongoose';
import {
  DealSchemaClass,
  DealSchemaDocument,
} from '../../deals/infrastructure/persistence/document/entities/deal.schema';
import { BaseReportFilterDto } from '../shared/dto/base-report-filter.dto';
import { ReportResponse } from '../shared/interfaces/report-response.interface';
import {
  getMongoDateFormat,
  parseReportDateRange,
} from '../shared/utils/report-date.util';
import { safePercent } from '../shared/utils/report-percentage.util';
import { buildReportResponse } from '../shared/utils/report-response.util';
import { GetDealReportDto } from './dto/get-deal-report.dto';
import {
  DealAgingBucket,
  DealVelocityData,
  OwnerPerformanceItem,
  PipelineSummaryItem,
  RevenueTrendPoint,
  WinLossRateData,
} from './interfaces/deal-report-types';

type DateContext = {
  from: Date;
  to: Date;
  timezone: string;
  requestedGranularity?: string;
  resolvedGranularity: 'day' | 'week' | 'month';
  warnings: string[];
};

@Injectable()
export class DealReportService {
  constructor(
    @InjectModel(DealSchemaClass.name)
    private readonly dealModel: Model<DealSchemaDocument>,
    private readonly cls: ClsService,
  ) {}

  // ── Report 1: Pipeline Summary ────────────────────────────────────────────

  async getPipelineSummary(
    dto: GetDealReportDto,
  ): Promise<ReportResponse<PipelineSummaryItem[]>> {
    const startedAt = process.hrtime.bigint();
    const match = this.buildBaseMatch(dto);

    const rows = await this.dealModel
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: '$stageId',
            dealCount: { $sum: 1 },
            totalValue: { $sum: '$value' },
            avgProbability: { $avg: { $ifNull: ['$probability', 0] } },
            weightedValueSum: {
              $sum: {
                $multiply: [
                  '$value',
                  { $divide: [{ $ifNull: ['$probability', 0] }, 100] },
                ],
              },
            },
          },
        },
        {
          $lookup: {
            from: 'dealstages',
            localField: '_id',
            foreignField: '_id',
            as: 'stage',
          },
        },
        { $unwind: { path: '$stage', preserveNullAndEmptyArrays: true } },
        { $sort: { 'stage.order': 1, dealCount: -1 } },
      ])
      .exec();

    const data: PipelineSummaryItem[] = rows.map((row) => ({
      stageId: row._id?.toString() ?? null,
      stageName: row.stage?.label ?? row.stage?.name ?? 'Unknown Stage',
      stageColor: row.stage?.color ?? '#64748b',
      dealCount: row.dealCount,
      totalValue: row.totalValue ?? 0,
      avgValue:
        row.dealCount > 0 ? Math.round(row.totalValue / row.dealCount) : 0,
      avgProbability: Math.round(row.avgProbability ?? 0),
      weightedValue: Math.round(row.weightedValueSum ?? 0),
    }));

    return buildReportResponse({
      report: 'pipeline_summary',
      dto,
      data,
      totalRecords: data.reduce((sum, item) => sum + item.dealCount, 0),
      startedAt,
    });
  }

  // ── Report 2: Revenue Trend ───────────────────────────────────────────────

  async getRevenueTrend(
    dto: GetDealReportDto,
  ): Promise<ReportResponse<RevenueTrendPoint[]>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const format = getMongoDateFormat(context.resolvedGranularity);
    const baseMatch = this.buildBaseMatch(dto);

    const [facetResult] = await this.dealModel
      .aggregate([
        {
          $match: {
            ...baseMatch,
            $or: [
              { wonAt: { $gte: context.from, $lte: context.to } },
              { lostAt: { $gte: context.from, $lte: context.to } },
            ],
          },
        },
        {
          $facet: {
            won: [
              { $match: { wonAt: { $gte: context.from, $lte: context.to } } },
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format,
                      date: '$wonAt',
                      timezone: context.timezone,
                    },
                  },
                  count: { $sum: 1 },
                  value: { $sum: '$value' },
                },
              },
            ],
            lost: [
              { $match: { lostAt: { $gte: context.from, $lte: context.to } } },
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format,
                      date: '$lostAt',
                      timezone: context.timezone,
                    },
                  },
                  count: { $sum: 1 },
                  value: { $sum: '$value' },
                },
              },
            ],
          },
        },
      ])
      .exec();

    const wonMap = new Map<string, { count: number; value: number }>(
      (facetResult?.won ?? []).map((r: any) => [
        r._id,
        { count: r.count, value: r.value },
      ]),
    );
    const lostMap = new Map<string, { count: number; value: number }>(
      (facetResult?.lost ?? []).map((r: any) => [
        r._id,
        { count: r.count, value: r.value },
      ]),
    );

    const allDates = new Set([...wonMap.keys(), ...lostMap.keys()]);
    const data: RevenueTrendPoint[] = [...allDates]
      .sort((a, b) => a.localeCompare(b))
      .map((date) => ({
        date,
        wonCount: wonMap.get(date)?.count ?? 0,
        lostCount: lostMap.get(date)?.count ?? 0,
        wonValue: wonMap.get(date)?.value ?? 0,
        lostValue: lostMap.get(date)?.value ?? 0,
      }));

    return buildReportResponse({
      report: 'revenue_trend',
      dto,
      data,
      totalRecords: data.reduce((sum, d) => sum + d.wonCount + d.lostCount, 0),
      startedAt,
      requestedGranularity: context.requestedGranularity,
      resolvedGranularity: context.resolvedGranularity,
      warnings: context.warnings,
    });
  }

  // ── Report 3: Win/Loss Rate ───────────────────────────────────────────────

  async getWinLossRate(
    dto: GetDealReportDto,
  ): Promise<ReportResponse<WinLossRateData>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const baseMatch = {
      ...this.buildBaseMatch(dto),
      createdAt: { $gte: context.from, $lte: context.to },
    };

    const [overall, byStageRows, bySourceRows] = await Promise.all([
      this.dealModel
        .aggregate([
          { $match: baseMatch },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              won: {
                $sum: {
                  $cond: [{ $ne: [{ $ifNull: ['$wonAt', null] }, null] }, 1, 0],
                },
              },
              lost: {
                $sum: {
                  $cond: [
                    { $ne: [{ $ifNull: ['$lostAt', null] }, null] },
                    1,
                    0,
                  ],
                },
              },
              totalValue: { $sum: '$value' },
              wonValue: {
                $sum: {
                  $cond: [
                    { $ne: [{ $ifNull: ['$wonAt', null] }, null] },
                    '$value',
                    0,
                  ],
                },
              },
            },
          },
        ])
        .exec(),
      this.dealModel
        .aggregate([
          { $match: baseMatch },
          {
            $group: {
              _id: '$stageId',
              won: {
                $sum: {
                  $cond: [{ $ne: [{ $ifNull: ['$wonAt', null] }, null] }, 1, 0],
                },
              },
              lost: {
                $sum: {
                  $cond: [
                    { $ne: [{ $ifNull: ['$lostAt', null] }, null] },
                    1,
                    0,
                  ],
                },
              },
            },
          },
          {
            $lookup: {
              from: 'dealstages',
              localField: '_id',
              foreignField: '_id',
              as: 'stage',
            },
          },
          { $unwind: { path: '$stage', preserveNullAndEmptyArrays: true } },
          { $sort: { won: -1 } },
        ])
        .exec(),
      this.dealModel
        .aggregate([
          { $match: baseMatch },
          {
            $group: {
              _id: '$sourceId',
              won: {
                $sum: {
                  $cond: [{ $ne: [{ $ifNull: ['$wonAt', null] }, null] }, 1, 0],
                },
              },
              lost: {
                $sum: {
                  $cond: [
                    { $ne: [{ $ifNull: ['$lostAt', null] }, null] },
                    1,
                    0,
                  ],
                },
              },
            },
          },
          {
            $lookup: {
              from: 'dealsources',
              localField: '_id',
              foreignField: '_id',
              as: 'source',
            },
          },
          { $unwind: { path: '$source', preserveNullAndEmptyArrays: true } },
          { $sort: { won: -1 } },
        ])
        .exec(),
    ]);

    const o = overall[0] ?? {
      total: 0,
      won: 0,
      lost: 0,
      totalValue: 0,
      wonValue: 0,
    };
    const open = o.total - o.won - o.lost;

    const data: WinLossRateData = {
      overall: {
        won: o.won,
        lost: o.lost,
        open: Math.max(0, open),
        winRate: safePercent(o.won, o.won + o.lost),
        totalValue: o.totalValue ?? 0,
        wonValue: o.wonValue ?? 0,
      },
      byStage: byStageRows.map((r: any) => ({
        stageId: r._id?.toString() ?? null,
        stageName: r.stage?.label ?? r.stage?.name ?? 'Unknown',
        won: r.won,
        lost: r.lost,
        winRate: safePercent(r.won, r.won + r.lost),
      })),
      bySource: bySourceRows.map((r: any) => ({
        sourceId: r._id?.toString() ?? null,
        sourceName: r.source?.name ?? 'Unknown',
        won: r.won,
        lost: r.lost,
        winRate: safePercent(r.won, r.won + r.lost),
      })),
    };

    return buildReportResponse({
      report: 'win_loss_rate',
      dto,
      data,
      totalRecords: o.total,
      startedAt,
    });
  }

  // ── Report 4: Deal Aging ──────────────────────────────────────────────────

  async getDealAging(
    dto: GetDealReportDto,
  ): Promise<ReportResponse<DealAgingBucket[]>> {
    const startedAt = process.hrtime.bigint();
    const now = new Date();
    const match = {
      ...this.buildBaseMatch(dto),
      wonAt: { $exists: false },
      lostAt: { $exists: false },
    };

    const [facetResult] = await this.dealModel
      .aggregate([
        { $match: match },
        {
          $addFields: {
            ageDays: {
              $dateDiff: { startDate: '$createdAt', endDate: now, unit: 'day' },
            },
          },
        },
        {
          $facet: {
            total: [{ $count: 'count' }],
            buckets: [
              {
                $bucket: {
                  groupBy: '$ageDays',
                  boundaries: [0, 7, 30, 90],
                  default: '90+',
                  output: {
                    count: { $sum: 1 },
                    totalValue: { $sum: '$value' },
                  },
                },
              },
            ],
          },
        },
      ])
      .exec();

    const total: number = facetResult?.total?.[0]?.count ?? 0;
    const rawBuckets: any[] = facetResult?.buckets ?? [];

    const bucketDefs = [
      { bucket: '0-6', label: '< 7 days', minDays: 0, maxDays: 6, key: 0 },
      { bucket: '7-29', label: '7–29 days', minDays: 7, maxDays: 29, key: 7 },
      {
        bucket: '30-89',
        label: '30–89 days',
        minDays: 30,
        maxDays: 89,
        key: 30,
      },
      {
        bucket: '90+',
        label: '90+ days',
        minDays: 90,
        maxDays: null,
        key: '90+',
      },
    ];

    const bucketMap = new Map(rawBuckets.map((b) => [String(b._id), b]));
    const data: DealAgingBucket[] = bucketDefs.map((def) => {
      const raw = bucketMap.get(String(def.key)) ?? { count: 0, totalValue: 0 };
      return {
        bucket: def.bucket,
        label: def.label,
        minDays: def.minDays,
        maxDays: def.maxDays,
        count: raw.count,
        totalValue: raw.totalValue ?? 0,
        percentage: safePercent(raw.count, total),
      };
    });

    return buildReportResponse({
      report: 'deal_aging',
      dto,
      data,
      totalRecords: total,
      startedAt,
    });
  }

  // ── Report 5: Owner Performance ───────────────────────────────────────────

  async getOwnerPerformance(
    dto: GetDealReportDto,
  ): Promise<ReportResponse<OwnerPerformanceItem[]>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const match = {
      ...this.buildBaseMatch(dto),
      createdAt: { $gte: context.from, $lte: context.to },
    };

    const rows = await this.dealModel
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: '$ownerId',
            totalDeals: { $sum: 1 },
            wonDeals: {
              $sum: {
                $cond: [{ $ne: [{ $ifNull: ['$wonAt', null] }, null] }, 1, 0],
              },
            },
            lostDeals: {
              $sum: {
                $cond: [{ $ne: [{ $ifNull: ['$lostAt', null] }, null] }, 1, 0],
              },
            },
            totalWonValue: {
              $sum: {
                $cond: [
                  { $ne: [{ $ifNull: ['$wonAt', null] }, null] },
                  '$value',
                  0,
                ],
              },
            },
          },
        },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'owner',
          },
        },
        { $unwind: { path: '$owner', preserveNullAndEmptyArrays: true } },
        { $sort: { wonDeals: -1 } },
      ])
      .exec();

    const data: OwnerPerformanceItem[] = rows.map((row) => {
      const ownerName = [row.owner?.firstName, row.owner?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      const openDeals = row.totalDeals - row.wonDeals - row.lostDeals;

      return {
        ownerId: row._id?.toString() ?? null,
        ownerName: ownerName || row.owner?.email || 'Unassigned',
        ownerEmail: row.owner?.email ?? '',
        totalDeals: row.totalDeals,
        wonDeals: row.wonDeals,
        lostDeals: row.lostDeals,
        openDeals: Math.max(0, openDeals),
        winRate: safePercent(row.wonDeals, row.wonDeals + row.lostDeals),
        totalWonValue: row.totalWonValue ?? 0,
        avgDealSize:
          row.wonDeals > 0 ? Math.round(row.totalWonValue / row.wonDeals) : 0,
      };
    });

    return buildReportResponse({
      report: 'owner_performance',
      dto,
      data,
      totalRecords: data.reduce((sum, d) => sum + d.totalDeals, 0),
      startedAt,
    });
  }

  // ── Report 6: Deal Velocity ───────────────────────────────────────────────

  async getDealVelocity(
    dto: GetDealReportDto,
  ): Promise<ReportResponse<DealVelocityData>> {
    const startedAt = process.hrtime.bigint();
    const context = this.resolveDateContext(dto);
    const match = {
      ...this.buildBaseMatch(dto),
      wonAt: { $gte: context.from, $lte: context.to },
    };

    const rows = await this.dealModel
      .find(match, { createdAt: 1, wonAt: 1, value: 1 })
      .lean()
      .exec();

    const daysToClose = rows
      .map((r) => {
        const diff =
          new Date(r.wonAt!).getTime() - new Date(r.createdAt).getTime();
        return diff / 86_400_000;
      })
      .filter((d) => d >= 0)
      .sort((a, b) => a - b);

    const avg =
      daysToClose.length > 0
        ? daysToClose.reduce((s, v) => s + v, 0) / daysToClose.length
        : 0;

    const median = this.computeMedian(daysToClose);

    const totalWonValue = rows.reduce((s, r) => s + (r.value ?? 0), 0);

    const data: DealVelocityData = {
      avgDaysToClose: Math.round(avg * 10) / 10,
      medianDaysToClose: Math.round(median * 10) / 10,
      totalWonDeals: rows.length,
      avgDealValue:
        rows.length > 0 ? Math.round(totalWonValue / rows.length) : 0,
    };

    return buildReportResponse({
      report: 'deal_velocity',
      dto,
      data,
      totalRecords: rows.length,
      startedAt,
    });
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  private buildBaseMatch(dto: GetDealReportDto): Record<string, any> {
    const match: Record<string, any> = {
      tenantId: this.tenantObjectId(),
      deletedAt: { $exists: false },
    };
    if (dto.ownerId) match.ownerId = new Types.ObjectId(dto.ownerId);
    if (dto.stageId) match.stageId = new Types.ObjectId(dto.stageId);
    if (dto.sourceId) match.sourceId = new Types.ObjectId(dto.sourceId);
    if (dto.pipeline) match.pipeline = dto.pipeline;
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
  private computeMedian(sorted: number[]): number {
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }
}
