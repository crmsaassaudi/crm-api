import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ChannelSchemaClass,
  ChannelSchemaDocument,
} from '../entities/channel.schema';
import { Channel } from '../../../../domain/channel';
import { ChannelMapper } from '../mappers/channel.mapper';

/**
 * Short-lived memo of `findAnyByAccount`, shared per process.
 *
 * Bounded by the number of connected channels, which is small, so it needs no
 * eviction beyond its TTL.
 */
const channelByAccountCache = new Map<
  string,
  { channel: Channel | null; expiresAt: number }
>();

const ACCOUNT_CACHE_TTL_MS = 15_000;

@Injectable()
export class ChannelRepository {
  constructor(
    @InjectModel(ChannelSchemaClass.name)
    private readonly model: Model<ChannelSchemaDocument>,
  ) {}

  async findAll(tenantId: string): Promise<Channel[]> {
    const docs = await this.model.find({ tenantId }).sort({ name: 1 }).exec();
    return docs.map(ChannelMapper.toDomain);
  }

  async findById(tenantId: string, id: string): Promise<Channel | null> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    return doc ? ChannelMapper.toDomain(doc) : null;
  }

  async findByAccount(
    tenantId: string,
    type: string,
    account: string,
  ): Promise<Channel | null> {
    const doc = await this.model.findOne({ tenantId, type, account }).exec();
    return doc ? ChannelMapper.toDomain(doc) : null;
  }

  /**
   * Resolve a channel from the provider's account id.
   *
   * This is the single hottest read in the omni pipeline — every inbound
   * message resolves its channel, bot config and credentials through it — so
   * results are memoised for a few seconds per process. The window is short
   * enough that a config change takes effect while an operator is still looking
   * at the screen, and a stale credential costs one retry rather than a
   * misroute.
   */
  async findAnyByAccount(
    type: string,
    account: string,
  ): Promise<Channel | null> {
    const cacheKey = `${type}:${account}`;
    const cached = channelByAccountCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.channel;
    }

    // Fetch up to 2 matches to detect ambiguous multi-tenant state. If the same
    // (type, account) exists in two tenants we must not silently pick one —
    // that would route a tenant's webhooks into another tenant's data.
    const docs = await this.model
      .find({ type, account })
      .select('+credentials')
      .setOptions({ isPlatformQuery: true } as any)
      .limit(2)
      .exec();

    if (docs.length > 1) {
      // Should be impossible while assertChannelAccountAvailable is enforced.
      const tenantIds = docs.map((d) => d.tenantId?.toString());
      throw new Error(
        `Ambiguous channel account: (${type}, ${account}) found in tenants [${tenantIds.join(', ')}]. ` +
          'Cannot determine webhook target. Remove the duplicate.',
      );
    }

    const channel = docs[0] ? ChannelMapper.toDomain(docs[0]) : null;
    channelByAccountCache.set(cacheKey, {
      channel,
      expiresAt: Date.now() + ACCOUNT_CACHE_TTL_MS,
    });
    return channel;
  }

  /** Drop the memoised lookup after a write that changes routing or credentials. */
  static invalidateAccountCache(type: string, account: string): void {
    channelByAccountCache.delete(`${type}:${account}`);
  }

  async findByAccountWithCredentials(
    tenantId: string,
    type: string,
    account: string,
  ): Promise<Channel | null> {
    const doc = await this.model
      .findOne({ tenantId, type, account, status: 'Connected' })
      .select('+credentials')
      .exec();
    return doc ? ChannelMapper.toDomain(doc) : null;
  }

  async findByIdWithCredentials(
    tenantId: string,
    id: string,
  ): Promise<Channel | null> {
    const doc = await this.model
      .findOne({ _id: id, tenantId })
      .select('+credentials')
      .exec();
    return doc ? ChannelMapper.toDomain(doc) : null;
  }

  /** Used by public widget config endpoint — no tenant filter */
  async findByIdNoTenant(id: string): Promise<Channel | null> {
    const doc = await this.model
      .findById(id)
      .setOptions({ isPlatformQuery: true } as any)
      .exec();
    return doc ? ChannelMapper.toDomain(doc) : null;
  }

  async create(data: Partial<Channel>): Promise<Channel> {
    const doc = await this.model.create(data);
    return ChannelMapper.toDomain(doc);
  }

  /**
   * @param onInsert fields written only when the document is created. Used for
   *   state an operator owns after creation — the support pool above all: this
   *   method is also how a channel is RE-connected, and a `$set` there would
   *   silently reset who is allowed to serve it.
   */
  async upsert(
    tenantId: string,
    type: string,
    account: string,
    data: Partial<Channel>,
    onInsert?: Partial<Channel>,
  ): Promise<{ channel: Channel; isNew: boolean }> {
    const updateData = { ...data } as any;
    delete updateData.tenantId;
    const doc = await this.model
      .findOneAndUpdate(
        { tenantId, type, account },
        {
          $set: { ...updateData, tenantId, type, account },
          ...(onInsert && Object.keys(onInsert).length > 0
            ? { $setOnInsert: onInsert as any }
            : {}),
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      )
      .setOptions({ isPlatformQuery: true } as any)
      .exec();
    // Mongoose doesn't expose isNew from findOneAndUpdate directly,
    // so we rely on updatedAt vs createdAt to detect new docs.
    const timeDiff = doc.updatedAt.getTime() - doc.createdAt.getTime();
    const isNew = timeDiff < 1000;
    ChannelRepository.invalidateAccountCache(type, account);
    return { channel: ChannelMapper.toDomain(doc), isNew };
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<Channel>,
  ): Promise<Channel | null> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .exec();
    if (doc) ChannelRepository.invalidateAccountCache(doc.type, doc.account);
    return doc ? ChannelMapper.toDomain(doc) : null;
  }

  /**
   * Strip a deleted user/group out of every channel's support pool in one
   * write. Called from the user/group deletion listeners — a dangling id would
   * otherwise shrink the eligible pool with nothing in the UI to explain it.
   */
  async pullSupportMembers(
    tenantId: string,
    pull: Record<string, unknown>,
  ): Promise<number> {
    const result = await this.model
      .updateMany({ tenantId }, { $pull: pull } as any)
      .exec();
    return result.modifiedCount ?? 0;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const doc = await this.model.findOne({ _id: id, tenantId }).exec();
    const result = await this.model.deleteOne({ _id: id, tenantId }).exec();
    if (doc) ChannelRepository.invalidateAccountCache(doc.type, doc.account);
    return result.deletedCount > 0;
  }
}
