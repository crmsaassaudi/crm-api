import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClsService } from 'nestjs-cls';
import { Model, Types } from 'mongoose';
import {
  ContactSchemaClass,
  ContactSchemaDocument,
} from '../../contacts/infrastructure/persistence/document/entities/contact.schema';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { BaseReportFilterDto } from '../shared/dto/base-report-filter.dto';
import {
  FunnelReportMeta,
  ReportResponse,
} from '../shared/interfaces/report-response.interface';
import {
  getMongoDateFormat,
  mergeGrowthBuckets,
  parseReportDateRange,
} from '../shared/utils/report-date.util';
import { safePercent } from '../shared/utils/report-percentage.util';
import { buildReportResponse } from '../shared/utils/report-response.util';
import { GetContactReportDto } from './dto/get-contact-report.dto';
import {
  AssignmentItem,
  FunnelLeakageItem,
  FunnelVelocityItem,
  GrowthDataPoint,
  OmniActivationItem,
  OptOutData,
  ScoreBucket,
  ShadowConversionData,
  SourceAttributionItem,
  StaleContactsData,
} from './interfaces/contact-report-types';

type DateContext = {
  from: Date;
  to: Date;
  timezone: string;
  requestedGranularity?: string;
  resolvedGranularity: 'day' | 'week' | 'month';
  warnings: string[];
};

type StageHistoryEntry = {
  fromStage?: string | null;
  toStage?: string | null;
  changedAt?: Date | string;
  direction?: 'forward' | 'backward' | 'lateral';
  skippedStages?: string[];
};

@Injectable()
export class ContactReportService {
  constructor(
    @InjectModel(ContactSchemaClass.name)
    private readonly contactModel: Model<ContactSchemaDocument>,
    private readonly settingsService: CrmSettingsService,
    private readonly cls: ClsService,
  ) {}

  async getGrowthTrend(
    dto: GetContactReportDto,
  ): Promise<ReportResponse<GrowthDataPoint[]>> {
    const startedAt = process.hrtime.bigint();
    const context = await this.resolveDateContext(dto);
    const format = getMongoDateFormat(context.resolvedGranularity);
    const baseMatch = this.buildBaseMatch(dto, { skipSoftDelete: true });

    // Single aggregation with $facet: one collection scan handles both the
    // created-bucket and the deleted-bucket. Old impl issued two parallel
    // aggregates which each scanned the contact collection independently.
    const facetMatchOr: any[] = [
      { createdAt: { $gte: context.from, $lte: context.to } },
      { deletedAt: { $gte: context.from, $lte: context.to } },
    ];
    const [facetResult] = await this.contactModel
      .aggregate([
        { $match: { ...baseMatch, $or: facetMatchOr } },
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
            deleted: [
              {
                $match: {
                  deletedAt: { $gte: context.from, $lte: context.to },
                },
              },
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format,
                      date: '$deletedAt',
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
    const deleted = facetResult?.deleted ?? [];

    const data = mergeGrowthBuckets(
      context.from,
      context.to,
      context.resolvedGranularity,
      created,
      deleted,
    );

    return buildReportResponse({
      report: 'growth_trend',
      dto,
      data,
      totalRecords: data.reduce(
        (sum, item) => sum + item.createdCount + item.deletedCount,
        0,
      ),
      startedAt,
      requestedGranularity: context.requestedGranularity,
      resolvedGranularity: context.resolvedGranularity,
      warnings: context.warnings,
    });
  }

  async getSourceAttribution(
    dto: GetContactReportDto,
  ): Promise<ReportResponse<SourceAttributionItem[]>> {
    const startedAt = process.hrtime.bigint();
    const context = await this.resolveDateContext(dto);
    const match = this.buildBaseMatch(dto, {
      createdBetween: { from: context.from, to: context.to },
    });
    // Combine countDocuments + group-by into a single pipeline. The old
    // version scanned the contact collection twice for the same filter.
    const [facetResult, sourceMap] = await Promise.all([
      this.contactModel
        .aggregate([
          { $match: match },
          {
            $facet: {
              total: [{ $count: 'count' }],
              rows: [
                {
                  $group: {
                    _id: { $ifNull: ['$sourceId', null] },
                    count: { $sum: 1 },
                  },
                },
                { $sort: { count: -1 } },
              ],
            },
          },
        ])
        .exec()
        .then((res) => res?.[0] ?? { total: [], rows: [] }),
      this.getSourceMap(),
    ]);
    const total: number = facetResult.total?.[0]?.count ?? 0;
    const rows: any[] = facetResult.rows ?? [];
    const data = rows.map((row) => {
      const sourceId = row._id ?? null;

      return {
        sourceId,
        sourceName: sourceId ? sourceMap.get(sourceId) ?? 'Unknown' : 'Unknown',
        count: row.count,
        percentage: safePercent(row.count, total),
      };
    });

    return buildReportResponse({
      report: 'source_attribution',
      dto,
      data,
      totalRecords: total,
      startedAt,
    });
  }

  async getAssignmentDistribution(
    dto: GetContactReportDto,
  ): Promise<ReportResponse<AssignmentItem[]>> {
    const startedAt = process.hrtime.bigint();
    const context = await this.resolveDateContext(dto);
    const match = this.buildBaseMatch(dto, {
      createdBetween: { from: context.from, to: context.to },
    });
    // Combine count + group/lookup into one pipeline so the contact
    // collection is scanned a single time.
    const [facetResult] = await this.contactModel
      .aggregate([
        { $match: match },
        {
          $facet: {
            total: [{ $count: 'count' }],
            rows: [
              {
                $group: {
                  _id: { $ifNull: ['$ownerId', null] },
                  count: { $sum: 1 },
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
              { $sort: { count: -1 } },
            ],
          },
        },
      ])
      .exec();
    const total: number = facetResult?.total?.[0]?.count ?? 0;
    const rows: any[] = facetResult?.rows ?? [];
    const data = rows.map((row) => {
      const ownerName = [row.owner?.firstName, row.owner?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();

      return {
        ownerId: row._id?.toString?.() ?? null,
        ownerName: ownerName || row.owner?.email || 'Unassigned',
        count: row.count,
        percentage: safePercent(row.count, total),
      };
    });

    return buildReportResponse({
      report: 'assignment_distribution',
      dto,
      data,
      totalRecords: total,
      startedAt,
    });
  }

  async getStaleContacts(
    dto: GetContactReportDto,
  ): Promise<ReportResponse<StaleContactsData>> {
    const startedAt = process.hrtime.bigint();
    const context = await this.resolveDateContext(dto);
    const match = this.buildBaseMatch(dto, { createdBeforeOrOn: context.to });
    const rows = await this.contactModel
      .aggregate([
        { $match: match },
        {
          $project: {
            inactiveDays: {
              $dateDiff: {
                startDate: { $ifNull: ['$lastActivityAt', '$createdAt'] },
                endDate: context.to,
                unit: 'day',
              },
            },
          },
        },
        {
          $group: {
            _id: null,
            active: {
              $sum: { $cond: [{ $lt: ['$inactiveDays', 30] }, 1, 0] },
            },
            days30: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gte: ['$inactiveDays', 30] },
                      { $lt: ['$inactiveDays', 60] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            days60: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gte: ['$inactiveDays', 60] },
                      { $lt: ['$inactiveDays', 90] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            days90: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gte: ['$inactiveDays', 90] },
                      { $lt: ['$inactiveDays', 180] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            days180: {
              $sum: { $cond: [{ $gte: ['$inactiveDays', 180] }, 1, 0] },
            },
          },
        },
      ])
      .exec();
    const row = rows[0] ?? {};
    const totalStale =
      (row.days30 ?? 0) + (row.days60 ?? 0) + (row.days90 ?? 0) + (row.days180 ?? 0);
    const total = totalStale + (row.active ?? 0);
    const buckets = [
      { days: 30, label: '30-59 days', count: row.days30 ?? 0 },
      { days: 60, label: '60-89 days', count: row.days60 ?? 0 },
      { days: 90, label: '90-179 days', count: row.days90 ?? 0 },
      { days: 180, label: '180+ days', count: row.days180 ?? 0 },
    ].map((bucket) => ({
      ...bucket,
      percentage: safePercent(bucket.count, total),
    }));
    const data = {
      buckets,
      totalStale,
      totalActive: row.active ?? 0,
    };

    return buildReportResponse({
      report: 'stale_contacts',
      dto,
      data,
      totalRecords: total,
      startedAt,
    });
  }

  async getScoreDistribution(
    dto: GetContactReportDto,
  ): Promise<ReportResponse<ScoreBucket[]>> {
    const startedAt = process.hrtime.bigint();
    const context = await this.resolveDateContext(dto);
    const match = this.buildBaseMatch(dto, {
      createdBetween: { from: context.from, to: context.to },
    });
    // Single aggregation: $facet so count and bucket pipeline both
    // re-use one collection scan via the shared $match stage above.
    const [facetResult] = await this.contactModel
      .aggregate([
        { $match: match },
        {
          $facet: {
            total: [{ $count: 'count' }],
            buckets: [
              {
                $project: {
                  score: {
                    $min: [100, { $max: [0, { $ifNull: ['$score', 0] }] }],
                  },
                },
              },
              {
                $bucket: {
                  groupBy: '$score',
                  boundaries: [0, 21, 41, 61, 81, 101],
                  default: 'other',
                  output: { count: { $sum: 1 } },
                },
              },
            ],
          },
        },
      ])
      .exec();
    const total: number = facetResult?.total?.[0]?.count ?? 0;
    const rows: any[] = facetResult?.buckets ?? [];
    const labels: Record<string, Pick<ScoreBucket, 'range' | 'label'>> = {
      '0': { range: '0-20', label: 'Low' },
      '21': { range: '21-40', label: 'Fair' },
      '41': { range: '41-60', label: 'Medium' },
      '61': { range: '61-80', label: 'High' },
      '81': { range: '81-100', label: 'Excellent' },
    };
    const counts = new Map(rows.map((row) => [String(row._id), row.count]));
    const data = Object.entries(labels).map(([key, value]) => {
      const count = counts.get(key) ?? 0;

      return {
        ...value,
        count,
        percentage: safePercent(count, total),
      };
    });

    return buildReportResponse({
      report: 'score_distribution',
      dto,
      data,
      totalRecords: total,
      startedAt,
    });
  }

  async getOptOutRate(
    dto: GetContactReportDto,
  ): Promise<ReportResponse<OptOutData>> {
    const startedAt = process.hrtime.bigint();
    const context = await this.resolveDateContext(dto);
    const match = this.buildBaseMatch(dto, {
      createdBetween: { from: context.from, to: context.to },
    });
    const rows = await this.contactModel
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            emailOptOut: {
              $sum: {
                $cond: [{ $ne: [{ $ifNull: ['$emailOptIn', false] }, true] }, 1, 0],
              },
            },
            smsOptOut: {
              $sum: {
                $cond: [{ $ne: [{ $ifNull: ['$smsOptIn', false] }, true] }, 1, 0],
              },
            },
            doNotCall: {
              $sum: { $cond: [{ $eq: ['$doNotCall', true] }, 1, 0] },
            },
          },
        },
      ])
      .exec();
    const row = rows[0] ?? { total: 0, emailOptOut: 0, smsOptOut: 0, doNotCall: 0 };
    const data = {
      emailOptOut: {
        count: row.emailOptOut,
        total: row.total,
        rate: safePercent(row.emailOptOut, row.total),
      },
      smsOptOut: {
        count: row.smsOptOut,
        total: row.total,
        rate: safePercent(row.smsOptOut, row.total),
      },
      doNotCall: {
        count: row.doNotCall,
        total: row.total,
        rate: safePercent(row.doNotCall, row.total),
      },
    };

    return buildReportResponse({
      report: 'opt_out_rate',
      dto,
      data,
      totalRecords: row.total,
      startedAt,
    });
  }

  async getOmniActivation(
    dto: GetContactReportDto,
  ): Promise<ReportResponse<OmniActivationItem[]>> {
    const startedAt = process.hrtime.bigint();
    const context = await this.resolveDateContext(dto);
    const match = this.buildBaseMatch(dto, {
      createdBetween: { from: context.from, to: context.to },
    });
    const pipeline: any[] = [
      { $match: match },
      { $unwind: '$omniIdentities' },
    ];

    if (dto.channel) {
      pipeline.push({ $match: { 'omniIdentities.channelType': dto.channel } });
    }

    pipeline.push(
      {
        $group: {
          _id: '$omniIdentities.channelType',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    );

    const [total, rows] = await Promise.all([
      this.contactModel.countDocuments(match).exec(),
      this.contactModel.aggregate(pipeline).exec(),
    ]);
    const data = rows.map((row) => ({
      channelType: row._id ?? 'unknown',
      count: row.count,
      percentage: safePercent(row.count, total),
    }));

    return buildReportResponse({
      report: 'omni_activation',
      dto,
      data,
      totalRecords: total,
      startedAt,
    });
  }

  async getShadowConversion(
    dto: GetContactReportDto,
  ): Promise<ReportResponse<ShadowConversionData>> {
    const startedAt = process.hrtime.bigint();
    const context = await this.resolveDateContext(dto);
    const format = getMongoDateFormat(context.resolvedGranularity);
    const match = {
      ...this.buildBaseMatch(dto, {
        createdBetween: { from: context.from, to: context.to },
      }),
      'omniIdentities.0': { $exists: true },
    };
    const convertedExpression = {
      $and: [
        { $eq: ['$isShadow', false] },
        {
          $or: [
            { $gt: [{ $size: { $ifNull: ['$emails', []] } }, 0] },
            { $gt: [{ $size: { $ifNull: ['$phones', []] } }, 0] },
          ],
        },
      ],
    };
    const [summary, trendRows] = await Promise.all([
      this.contactModel
        .aggregate([
          { $match: match },
          {
            $group: {
              _id: null,
              totalShadow: { $sum: 1 },
              convertedCount: {
                $sum: { $cond: [convertedExpression, 1, 0] },
              },
            },
          },
        ])
        .exec(),
      this.contactModel
        .aggregate([
          { $match: match },
          {
            $group: {
              _id: {
                $dateToString: {
                  format,
                  date: '$createdAt',
                  timezone: context.timezone,
                },
              },
              total: { $sum: 1 },
              converted: { $sum: { $cond: [convertedExpression, 1, 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .exec(),
    ]);
    const totals = summary[0] ?? { totalShadow: 0, convertedCount: 0 };
    const data = {
      totalShadow: totals.totalShadow,
      convertedCount: totals.convertedCount,
      conversionRate: safePercent(totals.convertedCount, totals.totalShadow),
      trend: trendRows.map((row) => ({
        date: row._id,
        converted: row.converted,
        total: row.total,
      })),
    };

    return buildReportResponse({
      report: 'shadow_conversion',
      dto,
      data,
      totalRecords: totals.totalShadow,
      startedAt,
      requestedGranularity: context.requestedGranularity,
      resolvedGranularity: context.resolvedGranularity,
      warnings: context.warnings,
    });
  }

  async getFunnelVelocity(
    dto: GetContactReportDto,
  ): Promise<ReportResponse<FunnelVelocityItem[], FunnelReportMeta>> {
    const startedAt = process.hrtime.bigint();
    const context = await this.resolveDateContext(dto);
    const [coverage, stageMap] = await Promise.all([
      this.getFunnelCoverage(dto, context.to),
      this.getStageMap(),
    ]);
    const match = {
      ...this.buildBaseMatch(dto, { createdBeforeOrOn: context.to }),
      'stageHistory.0': { $exists: true },
    };
    const contacts = await this.contactModel
      .find(match, { createdAt: 1, stageHistory: 1 })
      .lean()
      .exec();
    const transitions = new Map<string, number[]>();

    for (const contact of contacts) {
      const history = this.sortHistory(contact.stageHistory ?? []);
      for (let index = 0; index < history.length; index += 1) {
        const entry = history[index];
        const changedAt = this.toValidDate(entry.changedAt);
        if (!changedAt || changedAt < context.from || changedAt > context.to) {
          continue;
        }

        const previous = history[index - 1];
        const startedAtDate =
          this.toValidDate(previous?.changedAt) ??
          this.toValidDate((contact as any).createdAt);
        const fromStage = entry.fromStage ?? previous?.toStage ?? null;
        const toStage = entry.toStage ?? null;

        if (!startedAtDate || !fromStage || !toStage || fromStage === toStage) {
          continue;
        }

        const elapsedDays = Math.max(
          0,
          (changedAt.getTime() - startedAtDate.getTime()) / 86_400_000,
        );
        const key = `${fromStage}::${toStage}`;
        transitions.set(key, [...(transitions.get(key) ?? []), elapsedDays]);
      }
    }

    const data = [...transitions.entries()]
      .map(([key, values]) => {
        const [fromStage, toStage] = key.split('::');

        return {
          fromStage,
          fromStageName: stageMap.get(fromStage) ?? fromStage,
          toStage,
          toStageName: stageMap.get(toStage) ?? toStage,
          avgDays: this.roundOne(
            values.reduce((sum, value) => sum + value, 0) / values.length,
          ),
          medianDays: this.roundOne(this.median(values)),
          transitionCount: values.length,
        };
      })
      .sort((a, b) => b.transitionCount - a.transitionCount);

    return buildReportResponse({
      report: 'funnel_velocity',
      dto,
      data,
      totalRecords: contacts.length,
      startedAt,
      meta: { stageHistoryCoverage: coverage.coverage } as Partial<FunnelReportMeta>,
      warnings: coverage.warnings,
    });
  }

  async getFunnelLeakage(
    dto: GetContactReportDto,
  ): Promise<ReportResponse<FunnelLeakageItem[], FunnelReportMeta>> {
    const startedAt = process.hrtime.bigint();
    const context = await this.resolveDateContext(dto);
    const coverage = await this.getFunnelCoverage(dto, context.to);
    const match = {
      ...this.buildBaseMatch(dto, { createdBeforeOrOn: context.to }),
      'stageHistory.0': { $exists: true },
    };
    const contacts = await this.contactModel
      .find(match, { stageHistory: 1 })
      .lean()
      .exec();
    const leakage = new Map<string, FunnelLeakageItem>();

    for (const contact of contacts) {
      const history = this.sortHistory(contact.stageHistory ?? []);
      for (let index = 0; index < history.length; index += 1) {
        const entry = history[index];
        const changedAt = this.toValidDate(entry.changedAt);
        if (!changedAt || changedAt < context.from || changedAt > context.to) {
          continue;
        }

        const fromStage =
          entry.fromStage ?? history[index - 1]?.toStage ?? 'unknown';
        const toStage = entry.toStage ?? 'unknown';

        if (entry.direction === 'backward') {
          this.incrementLeakage(leakage, {
            type: 'backward',
            fromStage,
            toStage,
            count: 0,
          });
        }

        if (entry.skippedStages?.length) {
          this.incrementLeakage(leakage, {
            type: 'skipped',
            fromStage,
            toStage,
            count: 0,
            skippedStages: entry.skippedStages,
          });
        }
      }
    }

    const data = [...leakage.values()].sort((a, b) => b.count - a.count);

    return buildReportResponse({
      report: 'funnel_leakage',
      dto,
      data,
      totalRecords: contacts.length,
      startedAt,
      meta: { stageHistoryCoverage: coverage.coverage } as Partial<FunnelReportMeta>,
      warnings: coverage.warnings,
    });
  }

  private async resolveDateContext(dto: BaseReportFilterDto): Promise<DateContext> {
    const { from, to } = parseReportDateRange(dto.fromDate, dto.toDate);
    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      from > to
    ) {
      throw new BadRequestException('Invalid report date range');
    }

    const timezone = await this.resolveTimezone(dto);
    this.validateTimezone(timezone);

    const resolvedGranularity = BaseReportFilterDto.resolveGranularity(
      from,
      to,
      dto.granularity,
    );
    const warnings =
      dto.granularity && dto.granularity !== resolvedGranularity
        ? [
            `Granularity auto-adjusted from ${dto.granularity} to ${resolvedGranularity} for this date range.`,
          ]
        : [];

    return {
      from,
      to,
      timezone,
      requestedGranularity: dto.granularity,
      resolvedGranularity,
      warnings,
    };
  }

  private async resolveTimezone(dto: BaseReportFilterDto): Promise<string> {
    if (dto.timezone) return dto.timezone;
    const localization = await this.settingsService.getSetting('general_localization');
    return localization?.timezone || 'UTC';
  }

  private validateTimezone(timezone: string): void {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      throw new BadRequestException(`Invalid timezone: ${timezone}`);
    }
  }

  private buildBaseMatch(
    dto: GetContactReportDto,
    options: {
      skipSoftDelete?: boolean;
      createdBetween?: { from: Date; to: Date };
      createdBeforeOrOn?: Date;
    } = {},
  ): Record<string, any> {
    const match: Record<string, any> = {
      tenantId: this.resolveTenantId(),
    };

    if (!options.skipSoftDelete && !dto.includeDeleted) {
      match.deletedAt = { $exists: false };
    }

    if (options.createdBetween) {
      match.createdAt = {
        $gte: options.createdBetween.from,
        $lte: options.createdBetween.to,
      };
    } else if (options.createdBeforeOrOn) {
      match.createdAt = { $lte: options.createdBeforeOrOn };
    }

    if (dto.ownerId) match.ownerId = this.toObjectIdIfValid(dto.ownerId);
    if (dto.sourceId) match.sourceId = dto.sourceId;
    if (dto.stageId) match.lifecycleStageId = dto.stageId;
    if (dto.channel) match['omniIdentities.channelType'] = dto.channel;
    if (dto.isVIP !== undefined) match.isVIP = dto.isVIP;

    const visibleOwnerIds = this.cls.get('visibleOwnerIds');
    if (Array.isArray(visibleOwnerIds)) {
      match.$and = [
        ...(match.$and ?? []),
        {
          $or: [
            {
              ownerId: {
                $in: visibleOwnerIds.map((id) => this.toObjectIdIfValid(id)),
              },
            },
            { ownerId: null },
          ],
        },
      ];
    }

    return match;
  }

  private resolveTenantId(): Types.ObjectId | string {
    const tenantId = this.cls.get('activeTenantId') || this.cls.get('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context missing');
    }

    return this.toObjectIdIfValid(tenantId);
  }

  private toObjectIdIfValid(value: string): Types.ObjectId | string {
    return Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : value;
  }

  private async getSourceMap(): Promise<Map<string, string>> {
    const sourceSettings = await this.settingsService.getSetting('contact_source');
    const sources = Array.isArray(sourceSettings?.sources)
      ? sourceSettings.sources
      : [];

    return new Map(
      sources
        .filter((source: any) => source?.id)
        .map((source: any) => [source.id, source.name ?? source.id]),
    );
  }

  private async getStageMap(): Promise<Map<string, string>> {
    const lifecycle = await this.settingsService.getSetting('contact_lifecycle');
    const stages = Array.isArray(lifecycle?.stages) ? lifecycle.stages : [];
    const map = new Map<string, string>();

    for (const stage of stages) {
      if (stage.id) map.set(stage.id, stage.name ?? stage.id);
      if (stage.apiName) map.set(stage.apiName, stage.name ?? stage.apiName);
    }

    return map;
  }

  private async getFunnelCoverage(dto: GetContactReportDto, to: Date) {
    const match = this.buildBaseMatch(dto, { createdBeforeOrOn: to });
    const [totalContacts, contactsWithHistory, reliableRows] =
      await Promise.all([
        this.contactModel.countDocuments(match).exec(),
        this.contactModel
          .countDocuments({ ...match, 'stageHistory.0': { $exists: true } })
          .exec(),
        this.contactModel
          .aggregate([
            { $match: { ...match, 'stageHistory.0': { $exists: true } } },
            { $unwind: '$stageHistory' },
            { $group: { _id: null, reliableFrom: { $min: '$stageHistory.changedAt' } } },
          ])
          .exec(),
      ]);
    const coveragePercent = safePercent(contactsWithHistory, totalContacts);
    const warnings =
      coveragePercent < 50
        ? [
            'Funnel data covers less than 50% of contacts. Results may not be representative.',
          ]
        : [];

    return {
      coverage: {
        totalContacts,
        contactsWithHistory,
        coveragePercent,
        reliableFrom: reliableRows[0]?.reliableFrom?.toISOString?.() ?? null,
      },
      warnings,
    };
  }

  private sortHistory(history: StageHistoryEntry[]): StageHistoryEntry[] {
    return [...history].sort((a, b) => {
      const left = this.toValidDate(a.changedAt)?.getTime() ?? 0;
      const right = this.toValidDate(b.changedAt)?.getTime() ?? 0;

      return left - right;
    });
  }

  private toValidDate(value?: Date | string): Date | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);

    return Number.isNaN(date.getTime()) ? null : date;
  }

  private median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 1) return sorted[middle];
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  private roundOne(value: number): number {
    return Math.round(value * 10) / 10;
  }

  private incrementLeakage(
    leakage: Map<string, FunnelLeakageItem>,
    item: FunnelLeakageItem,
  ): void {
    const skippedKey = item.skippedStages?.join(',') ?? '';
    const key = `${item.type}::${item.fromStage}::${item.toStage}::${skippedKey}`;
    const current = leakage.get(key);

    if (current) {
      current.count += 1;
      return;
    }

    leakage.set(key, { ...item, count: 1 });
  }
}
