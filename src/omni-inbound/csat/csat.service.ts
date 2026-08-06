import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import {
  OmniConversationSchemaClass,
  OmniConversationDocument,
} from '../infrastructure/persistence/document/entities/omni-conversation.schema';
import { CrmEvents, OmniEvents } from '../domain/omni-events';
import { canChannel } from '../domain/channel-capabilities';
import type { AllConfigType } from '../../config/config.type';

/**
 * How long a survey link stays usable.
 *
 * Long enough for a customer to answer at their convenience, short enough that a
 * forwarded link is not a permanent write handle to the score.
 */
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SURVEY_PROMPT =
  'Thank you for contacting us. How would you rate this conversation?';

export type CsatScore = 1 | 2 | 3 | 4 | 5;

export interface CsatSubmitDto {
  score: CsatScore;
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
  breakdown: Record<CsatScore, number>;
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
    private readonly configService: ConfigService<AllConfigType>,
  ) {}

  /**
   * Mint a survey token for a resolved conversation.
   *
   * @returns the token, or null when the conversation is not this tenant's.
   */
  async generateToken(
    conversationId: string,
    tenantId: string,
  ): Promise<string | null> {
    const token = randomUUID().replace(/-/g, '');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    const result = await this.conversationModel.updateOne(
      { _id: conversationId, tenantId },
      { $set: { csatToken: token, csatTokenExpiresAt: expiresAt } },
    );

    // A silent no-op here used to look like success: the caller received a token
    // string for a conversation it had never written to.
    if (result.matchedCount === 0) {
      this.logger.warn(
        `CSAT token requested for conversation ${conversationId} outside tenant ${tenantId}`,
      );
      return null;
    }

    this.logger.log(`CSAT token generated for conversation ${conversationId}`);
    return token;
  }

  /**
   * Ask the customer how it went, once the conversation is resolved.
   *
   * Delivery is the part that was missing. A token was minted for every resolved
   * conversation and pushed over the livechat visitor socket — so livechat
   * visitors saw a survey and **every WhatsApp, Facebook, Instagram, Telegram and
   * email customer saw nothing at all**, on channels that carry most of the
   * volume. The score column stayed empty and read as "customers did not answer".
   *
   * Livechat still renders the survey in the widget (`omni.csat.token_generated`);
   * other channels get a message with the link, which is the only way to ask on a
   * channel we do not own the UI for.
   */
  @OnEvent(OmniEvents.CONVERSATION_STATUS_CHANGED, { async: true })
  async handleConversationResolved(payload: {
    tenantId: string;
    conversationId: string;
    status?: string;
    newStatus?: string;
    channelType?: string;
    agentId?: string;
  }): Promise<void> {
    const status = payload.newStatus ?? payload.status;
    if (status !== 'resolved') return;

    const channelType = payload.channelType;
    if (channelType && !canChannel(channelType, 'csat')) {
      this.logger.debug(
        `[CSAT] Skipping survey on ${channelType} — channel does not support it`,
      );
      return;
    }

    try {
      const token = await this.generateToken(
        payload.conversationId,
        payload.tenantId,
      );
      if (!token) return;

      // Livechat: the widget renders the survey inline from this event.
      this.eventEmitter.emit(OmniEvents.CSAT_TOKEN_GENERATED, {
        tenantId: payload.tenantId,
        conversationId: payload.conversationId,
        csatToken: token,
      });

      if (channelType && channelType !== 'livechat') {
        this.deliverSurveyLink(payload, token, channelType);
      }
    } catch (err) {
      this.logger.error(
        `[CSAT] Failed to send survey for ${payload.conversationId}:`,
        err,
      );
    }
  }

  /**
   * Send the survey link as a message on the customer's own channel.
   *
   * Sent through the system-reply seam so it is persisted, sequenced and visible
   * in the transcript — an agent reopening the thread can see the survey was
   * already asked for, and will not ask again.
   */
  private deliverSurveyLink(
    payload: { tenantId: string; conversationId: string },
    token: string,
    channelType: string,
  ): void {
    const baseUrl = this.configService.get('app.frontendDomain', {
      infer: true,
    });
    if (!baseUrl) {
      this.logger.error(
        '[CSAT] FRONTEND_DOMAIN is not configured — cannot build a survey link',
      );
      return;
    }

    const message = `${SURVEY_PROMPT} ${baseUrl.replace(/\/$/, '')}/survey?token=${token}`;
    this.eventEmitter.emit(OmniEvents.CSAT_SURVEY_REQUESTED, {
      tenantId: payload.tenantId,
      conversationId: payload.conversationId,
      channelType,
      message,
    });
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

    // isPlatformQuery: bypass tenant-filter plugin — this is a public/anonymous
    // endpoint with no CLS tenant context. The csatToken is the auth gate.
    const conversation = await this.conversationModel
      .findOne({ csatToken: token })
      .setOptions({ isPlatformQuery: true })
      .lean()
      .exec();

    if (!conversation) {
      throw new NotFoundException(
        'Survey link is invalid or has already been used',
      );
    }

    // Expiry is enforced here rather than by a TTL index: the token has to become
    // unusable at a known moment, and a TTL index would delete the whole
    // conversation. Reported as "expired" separately from "invalid" so a customer
    // clicking an old link is told something true.
    const expiresAt = conversation.csatTokenExpiresAt;
    if (expiresAt && expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('This survey link has expired');
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
          csatTokenExpiresAt: null,
        },
      },
      { isPlatformQuery: true } as any,
    );

    const conversationId = String(conversation._id);

    this.logger.log(
      `CSAT submitted: conversation=${conversationId} score=${dto.score} tenantId=${conversation.tenantId}`,
    );

    // Carries the channel so consumers can act per channel — the livechat widget
    // webhook needs it to resolve which widget to notify.
    this.eventEmitter.emit(CrmEvents.CSAT_SUBMITTED, {
      tenantId: String(conversation.tenantId),
      conversationId,
      agentId: conversation.assignedAgentId,
      channelType: conversation.channelType,
      channelId: conversation.channelId
        ? String(conversation.channelId)
        : undefined,
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
      breakdown: breakdown as Record<CsatScore, number>,
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
