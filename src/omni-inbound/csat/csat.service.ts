import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  OmniConversationSchemaClass,
  OmniConversationDocument,
} from '../infrastructure/persistence/document/entities/omni-conversation.schema';

export interface CsatSubmitDto {
  score: 1 | 2 | 3 | 4 | 5;
  comment?: string;
}

export interface CsatTokenPayload {
  conversationId: string;
  tenantId: string;
  agentId: string | null;
  channelType: string;
  resolvedAt: Date | null;
}

export interface CsatAggregateResult {
  totalSurveys: number;
  responded: number;
  responseRate: number;
  avgScore: number | null;
  breakdown: Record<1 | 2 | 3 | 4 | 5, number>;
  byAgent: Array<{
    agentId: string;
    avgScore: number;
    count: number;
  }>;
  byChannel: Array<{
    channelType: string;
    avgScore: number;
    count: number;
  }>;
}

@Injectable()
export class CsatService {
  private readonly logger = new Logger(CsatService.name);

  constructor(
    @InjectModel(OmniConversationSchemaClass.name)
    private readonly conversationModel: Model<OmniConversationDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Generate a CSAT survey token for a resolved conversation.
   * Called when an agent resolves/closes a conversation.
   * Returns the token to be embedded in the survey URL.
   */
  async generateToken(
    conversationId: string,
    tenantId: string,
  ): Promise<string> {
    const token = randomUUID().replace(/-/g, '');

    await this.conversationModel.updateOne(
      { _id: conversationId, tenantId },
      { $set: { csatToken: token } },
    );

    this.logger.log(`CSAT token generated for conversation ${conversationId}`);
    return token;
  }

  /**
   * Public endpoint — validate token, record CSAT score.
   * No auth required (customer submits via survey link).
   */
  async submitByToken(
    token: string,
    dto: CsatSubmitDto,
  ): Promise<{ success: boolean; conversationId: string }> {
    if (dto.score < 1 || dto.score > 5) {
      throw new BadRequestException('Score must be between 1 and 5');
    }

    const conversation = await this.conversationModel
      .findOne({ csatToken: token })
      .lean()
      .exec();

    if (!conversation) {
      throw new NotFoundException(
        'Survey link is invalid or has already been used',
      );
    }

    if (conversation.csatScore !== null) {
      throw new BadRequestException('CSAT survey has already been submitted');
    }

    await this.conversationModel.updateOne(
      { _id: conversation._id },
      {
        $set: {
          csatScore: dto.score,
          csatComment: dto.comment ?? null,
          csatSubmittedAt: new Date(),
          csatToken: null, // Invalidate token after use
        },
      },
    );

    const conversationId = String(conversation._id);

    this.logger.log(
      `CSAT submitted: conversation=${conversationId} score=${dto.score} tenantId=${conversation.tenantId}`,
    );

    // Emit event for realtime notification to agent dashboard
    this.eventEmitter.emit('csat.submitted', {
      tenantId: String(conversation.tenantId),
      conversationId,
      agentId: conversation.assignedAgentId,
      score: dto.score,
      comment: dto.comment,
      submittedAt: new Date(),
    });

    return { success: true, conversationId };
  }

  /**
   * Aggregate CSAT metrics for reporting.
   * Supports filtering by dateRange, agentId, channelId.
   */
  async getReport(
    tenantId: string,
    filters: {
      from?: string;
      to?: string;
      agentId?: string;
      channelType?: string;
    },
  ): Promise<CsatAggregateResult> {
    const matchStage: Record<string, any> = {
      tenantId,
      status: { $in: ['resolved', 'closed'] },
    };

    if (filters.from || filters.to) {
      matchStage.resolvedAt = {};
      if (filters.from) matchStage.resolvedAt.$gte = new Date(filters.from);
      if (filters.to) matchStage.resolvedAt.$lte = new Date(filters.to);
    }
    if (filters.agentId) matchStage.assignedAgentId = filters.agentId;
    if (filters.channelType) matchStage.channelType = filters.channelType;

    // Total conversations that were resolved (survey sent)
    const totalSurveys =
      await this.conversationModel.countDocuments(matchStage);

    // Conversations with CSAT submitted
    const respondedMatch = { ...matchStage, csatScore: { $ne: null } };
    const responded =
      await this.conversationModel.countDocuments(respondedMatch);

    // Score distribution
    const scorePipeline = await this.conversationModel
      .aggregate([
        { $match: respondedMatch },
        {
          $group: {
            _id: '$csatScore',
            count: { $sum: 1 },
          },
        },
      ])
      .exec();

    const breakdown: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let totalScore = 0;
    for (const row of scorePipeline) {
      breakdown[row._id as number] = row.count;
      totalScore += row._id * row.count;
    }

    const avgScore =
      responded > 0 ? Math.round((totalScore / responded) * 10) / 10 : null;

    // By agent
    const byAgentRaw = await this.conversationModel
      .aggregate([
        { $match: respondedMatch },
        {
          $group: {
            _id: '$assignedAgentId',
            avgScore: { $avg: '$csatScore' },
            count: { $sum: 1 },
          },
        },
        { $sort: { avgScore: -1 } },
      ])
      .exec();

    // By channel
    const byChannelRaw = await this.conversationModel
      .aggregate([
        { $match: respondedMatch },
        {
          $group: {
            _id: '$channelType',
            avgScore: { $avg: '$csatScore' },
            count: { $sum: 1 },
          },
        },
        { $sort: { avgScore: -1 } },
      ])
      .exec();

    return {
      totalSurveys,
      responded,
      responseRate:
        totalSurveys > 0 ? Math.round((responded / totalSurveys) * 100) : 0,
      avgScore,
      breakdown: breakdown as Record<1 | 2 | 3 | 4 | 5, number>,
      byAgent: byAgentRaw.map((r) => ({
        agentId: String(r._id),
        avgScore: Math.round(r.avgScore * 10) / 10,
        count: r.count,
      })),
      byChannel: byChannelRaw.map((r) => ({
        channelType: String(r._id),
        avgScore: Math.round(r.avgScore * 10) / 10,
        count: r.count,
      })),
    };
  }
}
