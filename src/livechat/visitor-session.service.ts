import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  VisitorSession,
  VisitorSessionDocument,
} from './visitor-session.schema';

@Injectable()
export class VisitorSessionService {
  private readonly logger = new Logger(VisitorSessionService.name);

  constructor(
    @InjectModel(VisitorSession.name)
    private readonly sessionModel: Model<VisitorSessionDocument>,
  ) {}

  /**
   * Upserts a visitor session. Creates on first connection, updates socketId on reconnect.
   */
  async upsert(data: {
    visitorId: string;
    tenantId: string;
    channelId: string;
    socketId?: string;
    pageUrl?: string;
    userAgent?: string;
  }): Promise<VisitorSession> {
    return this.sessionModel
      .findOneAndUpdate(
        { visitorId: data.visitorId, tenantId: data.tenantId },
        {
          $set: {
            channelId: data.channelId,
            socketId: data.socketId,
            pageUrl: data.pageUrl,
            userAgent: data.userAgent,
            lastSeenAt: new Date(),
          },
          $setOnInsert: { startedAt: new Date() },
        },
        { upsert: true, new: true },
      )
      .lean()
      .exec() as Promise<VisitorSession>;
  }

  /**
   * Enriches a session with identity data (email, name, contactId).
   */
  async enrich(
    visitorId: string,
    tenantId: string,
    data: { email?: string; name?: string; contactId?: string },
  ): Promise<VisitorSession | null> {
    return this.sessionModel
      .findOneAndUpdate(
        { visitorId, tenantId },
        { $set: { ...data, lastSeenAt: new Date() } },
        { new: true },
      )
      .lean()
      .exec() as Promise<VisitorSession | null>;
  }

  /**
   * Links a conversation to a visitor session.
   */
  async linkConversation(
    visitorId: string,
    tenantId: string,
    conversationId: string,
  ): Promise<void> {
    await this.sessionModel
      .updateOne({ visitorId, tenantId }, { $set: { conversationId } })
      .exec();
  }

  /**
   * Gets a session by visitorId + tenantId.
   */
  async getByVisitor(
    visitorId: string,
    tenantId: string,
  ): Promise<VisitorSession | null> {
    return this.sessionModel
      .findOne({ visitorId, tenantId })
      .lean()
      .exec() as Promise<VisitorSession | null>;
  }

  /**
   * Gets a session by socketId (used on disconnect to clean up).
   */
  async getBySocketId(socketId: string): Promise<VisitorSession | null> {
    return this.sessionModel
      .findOne({ socketId })
      .lean()
      .exec() as Promise<VisitorSession | null>;
  }

  /**
   * Updates socket ID (called on reconnect).
   */
  async updateSocketId(
    visitorId: string,
    tenantId: string,
    socketId: string,
  ): Promise<void> {
    await this.sessionModel
      .updateOne(
        { visitorId, tenantId },
        { $set: { socketId, lastSeenAt: new Date() } },
      )
      .exec();
  }
}
