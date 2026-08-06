import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  DealStageDocument,
  DealStageSchemaClass,
} from './entities/deal-stage.schema';
import {
  PipelineDocument,
  PipelineSchemaClass,
} from './entities/pipeline.schema';
import {
  DealSourceDocument,
  DealSourceSchemaClass,
} from './entities/deal-source.schema';

/**
 * A starter pipeline for a B2C/SMB workspace.
 *
 * Deliberately short. A five-stage enterprise funnel is wrong for a clinic or a
 * retail shop, and a pipeline whose stages nobody uses trains reps to leave
 * every deal in column one.
 */
const DEFAULT_STAGES = [
  {
    label: 'New Lead',
    apiName: 'new_lead',
    probability: 10,
    color: '#64748b',
    isDefault: true,
  },
  {
    label: 'Contacted',
    apiName: 'contacted',
    probability: 25,
    color: '#3b82f6',
  },
  {
    label: 'Interested',
    apiName: 'interested',
    probability: 50,
    color: '#8b5cf6',
  },
  {
    label: 'Negotiation',
    apiName: 'negotiation',
    probability: 75,
    color: '#f59e0b',
  },
  {
    label: 'Won',
    apiName: 'won',
    probability: 100,
    color: '#10b981',
    isWon: true,
  },
  {
    label: 'Lost',
    apiName: 'lost',
    probability: 0,
    color: '#ef4444',
    isLost: true,
  },
] as const;

/** Channels an SMB actually acquires from, so attribution has buckets on day one. */
const DEFAULT_SOURCES = [
  'Facebook',
  'Instagram',
  'WhatsApp',
  'Website',
  'Walk-in',
  'Referral',
  'Phone',
] as const;

/**
 * Materialises a workspace's first pipeline, stages and sources.
 *
 * These used to live as a JSON blob in `crm_settings.deal_pipeline` while the
 * deal document referenced the `deal_stages` collection, so a fresh tenant had a
 * pipeline the settings screen could render and no stage any deal could point
 * at. One authority now: the collections.
 *
 * Idempotent — the tenant-created listener replays every step on retry.
 */
@Injectable()
export class DealPipelineSeederService {
  private readonly logger = new Logger(DealPipelineSeederService.name);

  constructor(
    @InjectModel(PipelineSchemaClass.name)
    private readonly pipelineModel: Model<PipelineDocument>,
    @InjectModel(DealStageSchemaClass.name)
    private readonly stageModel: Model<DealStageDocument>,
    @InjectModel(DealSourceSchemaClass.name)
    private readonly sourceModel: Model<DealSourceDocument>,
  ) {}

  async seedForTenant(tenantId: string): Promise<void> {
    const tenant = new Types.ObjectId(tenantId);

    const existing = await this.pipelineModel
      .findOne({ tenantId: tenant })
      .setOptions({ isPlatformQuery: true } as any)
      .select({ _id: 1 })
      .lean()
      .exec();
    if (existing) return;

    const pipeline = await this.pipelineModel.create({
      tenantId: tenant,
      name: 'Sales Pipeline',
      isDefault: true,
      sortOrder: 0,
    });

    await this.stageModel.insertMany(
      DEFAULT_STAGES.map((stage, index) => ({
        ...stage,
        tenantId: tenant,
        pipelineId: pipeline._id,
        sortOrder: index,
      })),
    );

    await this.sourceModel.insertMany(
      DEFAULT_SOURCES.map((name, index) => ({
        tenantId: tenant,
        name,
        sortOrder: index,
      })),
    );

    this.logger.log(
      `Seeded default deal pipeline for tenant ${tenantId} (${DEFAULT_STAGES.length} stages)`,
    );
  }
}
