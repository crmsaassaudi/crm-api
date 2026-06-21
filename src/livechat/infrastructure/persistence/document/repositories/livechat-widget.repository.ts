import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  LivechatWidgetSchemaClass,
  LivechatWidgetSchemaDocument,
} from '../entities/livechat-widget.schema';
import { LivechatWidget } from '../../../../domain/livechat-widget';

@Injectable()
export class LivechatWidgetRepository {
  constructor(
    @InjectModel(LivechatWidgetSchemaClass.name)
    private readonly model: Model<LivechatWidgetSchemaDocument>,
  ) {}

  // ── Queries ──────────────────────────────────────────────────────────────

  async findByWidgetId(widgetId: string): Promise<LivechatWidget | null> {
    const doc = await this.model
      .findOne({ widgetId })
      .setOptions({ isPlatformQuery: true } as any) // no tenant filter — public endpoint
      .exec();
    return doc ? this.toDomain(doc) : null;
  }

  async findByWidgetIdWithTenant(
    widgetId: string,
    tenantId: string,
  ): Promise<LivechatWidget | null> {
    const doc = await this.model.findOne({ widgetId, tenantId }).exec();
    return doc ? this.toDomain(doc) : null;
  }

  async findByTenantId(tenantId: string): Promise<LivechatWidget[]> {
    const docs = await this.model
      .find({ tenantId })
      .sort({ createdAt: -1 })
      .exec();
    return docs.map((d) => this.toDomain(d));
  }

  async findByChannelId(
    tenantId: string,
    channelId: string,
  ): Promise<LivechatWidget[]> {
    const docs = await this.model
      .find({ tenantId, channelId })
      .sort({ createdAt: -1 })
      .exec();
    return docs.map((d) => this.toDomain(d));
  }

  async findById(tenantId: string, id: string): Promise<LivechatWidget | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? this.toDomain(doc) : null;
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  async create(data: Partial<LivechatWidget>): Promise<LivechatWidget> {
    const doc = await this.model.create(data);
    return this.toDomain(doc);
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<LivechatWidget>,
  ): Promise<LivechatWidget | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .exec();
    return doc ? this.toDomain(doc) : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.model
      .findOneAndDelete({ _id: id, tenantId })
      .exec();
    return !!result;
  }

  // ── Mapper ───────────────────────────────────────────────────────────────

  private toDomain(raw: LivechatWidgetSchemaClass): LivechatWidget {
    const w = new LivechatWidget();
    w.id = raw._id?.toString();
    w.widgetId = raw.widgetId;
    w.tenantId = raw.tenantId?.toString();
    w.channelId = raw.channelId?.toString();
    w.name = raw.name;
    w.status = raw.status;
    w.branding = raw.branding || {};
    w.theme = raw.theme || {};
    w.layout = raw.layout || {};
    w.welcome = raw.welcome || {};
    w.conversationStarters = (raw.conversationStarters ||
      []) as LivechatWidget['conversationStarters'];
    w.offline = raw.offline || {};
    w.preChatForm = raw.preChatForm || {};
    w.routing = raw.routing || {};
    w.automation = raw.automation || {};
    w.proactiveChat = raw.proactiveChat || {};
    w.security = raw.security || {};
    w.localization = raw.localization || {};
    w.advanced = raw.advanced || {};
    w.csat = raw.csat || {};
    w.createdAt = raw.createdAt;
    w.updatedAt = raw.updatedAt;
    return w;
  }
}
