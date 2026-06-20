import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  WidgetEventSchemaClass,
  WidgetEventDocument,
} from '../entities/widget-event.schema';

interface TrackEventDto {
  widgetId: string;
  tenantId: string;
  event: string;
  data?: Record<string, any>;
  visitorId?: string;
  sessionId?: string;
  pageUrl?: string;
  domain?: string;
  isMobile?: boolean;
}

interface DateRange {
  from: Date;
  to: Date;
}

@Injectable()
export class WidgetEventRepository {
  constructor(
    @InjectModel(WidgetEventSchemaClass.name)
    private readonly model: Model<WidgetEventDocument>,
  ) {}

  async track(dto: TrackEventDto): Promise<void> {
    await this.model.create({
      ...dto,
      tenantId: new Types.ObjectId(dto.tenantId),
    });
  }

  async trackBatch(events: TrackEventDto[]): Promise<void> {
    if (!events.length) return;
    await this.model.insertMany(
      events.map((e) => ({
        ...e,
        tenantId: new Types.ObjectId(e.tenantId),
      })),
    );
  }

  /**
   * Count events by type for a widget within a date range.
   */
  async countByEvent(
    widgetId: string,
    event: string,
    range: DateRange,
  ): Promise<number> {
    return this.model.countDocuments({
      widgetId,
      event,
      createdAt: { $gte: range.from, $lte: range.to },
    });
  }

  /**
   * Aggregate event counts grouped by day.
   */
  async dailyCounts(
    widgetId: string,
    event: string,
    range: DateRange,
  ): Promise<{ date: string; count: number }[]> {
    const result = await this.model.aggregate([
      {
        $match: {
          widgetId,
          event,
          createdAt: { $gte: range.from, $lte: range.to },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    return result.map((r) => ({ date: r._id, count: r.count }));
  }

  /**
   * Get summary stats for a widget.
   */
  async getSummary(
    widgetId: string,
    range: DateRange,
  ): Promise<Record<string, number>> {
    const result = await this.model.aggregate([
      {
        $match: {
          widgetId,
          createdAt: { $gte: range.from, $lte: range.to },
        },
      },
      {
        $group: {
          _id: '$event',
          count: { $sum: 1 },
        },
      },
    ]);
    const summary: Record<string, number> = {};
    for (const r of result) {
      summary[r._id] = r.count;
    }
    return summary;
  }

  /**
   * Top pages by event count.
   */
  async topPages(
    widgetId: string,
    range: DateRange,
    limit = 10,
  ): Promise<{ page: string; count: number }[]> {
    const result = await this.model.aggregate([
      {
        $match: {
          widgetId,
          event: 'widget.impression',
          pageUrl: { $exists: true, $ne: null },
          createdAt: { $gte: range.from, $lte: range.to },
        },
      },
      {
        $group: { _id: '$pageUrl', count: { $sum: 1 } },
      },
      { $sort: { count: -1 } },
      { $limit: limit },
    ]);
    return result.map((r) => ({ page: r._id, count: r.count }));
  }
}
