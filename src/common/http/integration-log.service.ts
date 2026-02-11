import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { IntegrationLog, IntegrationLogDocument } from './integration-log.schema';

export interface IntegrationLogDto {
    service: string;
    url: string;
    method: string;
    status: number;
    success: boolean;
    retries: number;
    breakerOpen: boolean;
    durationMs: number;
    correlationId?: string;
}

@Injectable()
export class IntegrationLogService {
    private readonly logger = new Logger(IntegrationLogService.name);

    constructor(
        @InjectModel(IntegrationLog.name)
        private readonly integrationLogModel: Model<IntegrationLogDocument>,
    ) { }

    async logRequest(data: IntegrationLogDto) {
        // Log asynchronously without blocking
        this.integrationLogModel.create(data).catch((err) => {
            this.logger.error(`Failed to log integration request: ${err.message}`, err.stack);
        });
    }

    async getAggregatedMetrics() {
        // Aggregation pipeline to calculate metrics per service
        const metrics = await this.integrationLogModel.aggregate([
            {
                $group: {
                    _id: '$service',
                    total: { $sum: 1 },
                    success: { $sum: { $cond: ['$success', 1, 0] } },
                    failure: { $sum: { $cond: ['$success', 0, 1] } },
                    totalDuration: { $sum: '$durationMs' },
                },
            },
            {
                $project: {
                    service: '$_id',
                    total: 1,
                    success: 1,
                    failure: 1,
                    avgTime: { $divide: ['$totalDuration', '$total'] },
                    errorRate: {
                        $multiply: [
                            { $divide: ['$failure', { $max: ['$total', 1] }] },
                            100,
                        ],
                    },
                },
            },
        ]);

        // Transform array to object keyed by service name
        const result: Record<string, any> = {};
        metrics.forEach((m) => {
            result[m.service] = {
                total: m.total,
                success: m.success,
                error: m.failure,
                errorRate: parseFloat(m.errorRate.toFixed(2)),
                avgTime: Math.round(m.avgTime),
            };
        });

        return result;
    }

    async getRecentLogs(limit: number = 100) {
        return this.integrationLogModel.find().sort({ createdAt: -1 }).limit(limit).exec();
    }
}
