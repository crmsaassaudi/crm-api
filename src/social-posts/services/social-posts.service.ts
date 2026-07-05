import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ulid } from 'ulid';
import { AiVideoJobService } from '../../ai-video/services/ai-video-job.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Channel } from '../../channels/domain/channel';
import { ChannelRepository } from '../../channels/infrastructure/persistence/document/repositories/channel.repository';
import {
  CreatePublicationInstancesDto,
  CreateSocialContentAssetDto,
  ListPublicationInstancesQueryDto,
  ListSocialContentAssetsQueryDto,
  RejectSocialContentAssetVersionDto,
  UpdatePublicationInstanceDto,
  UpdateSocialContentAssetDto,
} from '../dto/social-post.dto';
import { normalizePublisherError } from '../publishers/publisher-error.util';
import { SocialPublisherRegistry } from '../publishers/social-publisher-registry.service';
import {
  SocialContentAssetEntity,
  SocialContentAssetRepository,
} from '../repositories/social-post.repository';
import {
  PublicationInstanceEntity,
  PublicationInstanceRepository,
} from '../repositories/social-post-task.repository';
import {
  SocialContentAssetVersionEntity,
  SocialContentAssetVersionRepository,
} from '../repositories/social-post-version.repository';
import {
  SOCIAL_CONTENT_PLATFORMS,
  PublicationSnapshot,
  SocialContentMediaType,
  SocialContentPlatform,
} from '../social-posts.types';
import { PublicationQueueProducer } from './social-post-queue.producer';

export interface SocialContentAssetWithDetails
  extends SocialContentAssetEntity {
  latestVersion?: SocialContentAssetVersionEntity;
  publicationCounts: {
    pending: number;
    publishing: number;
    success: number;
    failed: number;
    canceled: number;
  };
  publications?: PublicationInstanceEntity[];
}

@Injectable()
export class SocialContentAssetsService {
  private readonly logger = new Logger(SocialContentAssetsService.name);

  constructor(
    private readonly assetRepository: SocialContentAssetRepository,
    private readonly publicationRepository: PublicationInstanceRepository,
    private readonly versionRepository: SocialContentAssetVersionRepository,
    private readonly channelRepository: ChannelRepository,
    private readonly publisherRegistry: SocialPublisherRegistry,
    private readonly queueProducer: PublicationQueueProducer,
    private readonly aiVideoJobService: AiVideoJobService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService,
  ) {}

  async create(
    dto: CreateSocialContentAssetDto,
  ): Promise<SocialContentAssetWithDetails> {
    const tenantId = this.requireTenantId();
    const userId = this.cls.get('userId');
    const aiVideoJobIds = dto.aiVideoJobIds ?? [];
    const mediaUrls = await this.resolveMediaUrls(
      tenantId,
      dto.mediaUrls ?? [],
      aiVideoJobIds,
    );
    const mediaType = dto.mediaType ?? this.inferMediaType(mediaUrls);
    const title = this.resolveTitle(dto.title, dto.content, mediaUrls);

    const asset = await this.assetRepository.create({
      tenantId,
      title,
      status: 'ACTIVE',
      createdById: userId,
    });

    const version = await this.versionRepository.create({
      tenantId,
      assetId: asset.id,
      versionNumber: 1,
      content: dto.content,
      mediaUrls,
      aiVideoJobIds,
      mediaType,
      approvalStatus: 'PENDING',
      savedById: userId,
    });

    const updatedAsset = await this.assetRepository.update(tenantId, asset.id, {
      latestVersionId: version.id,
    } as any);

    this.recordAssetAudit(tenantId, asset.id, 'SOCIAL_ASSET_CREATED', {
      actorId: userId,
      metadata: { versionId: version.id, versionNumber: 1 },
    });

    return this.decorateAsset(updatedAsset ?? asset, {
      latestVersion: version,
      includePublications: true,
    });
  }

  async findPaginated(query: ListSocialContentAssetsQueryDto) {
    const tenantId = this.requireTenantId();
    const result = await this.assetRepository.findPaginated(
      {
        tenantId,
        status: query.status,
      },
      Number(query.page ?? 1),
      Number(query.limit ?? 20),
    );

    const decorated = await Promise.all(
      result.items.map((asset) =>
        this.decorateAsset(asset, { includePublications: false }),
      ),
    );
    const items = query.approvalStatus
      ? decorated.filter(
          (asset) =>
            asset.latestVersion?.approvalStatus === query.approvalStatus,
        )
      : decorated;

    return {
      items,
      total: query.approvalStatus ? items.length : result.total,
    };
  }

  async findById(id: string): Promise<SocialContentAssetWithDetails> {
    const tenantId = this.requireTenantId();
    const asset = await this.findAssetOrThrow(tenantId, id);
    return this.decorateAsset(asset, { includePublications: true });
  }

  async update(
    id: string,
    dto: UpdateSocialContentAssetDto,
  ): Promise<SocialContentAssetWithDetails> {
    const tenantId = this.requireTenantId();
    const userId = this.cls.get('userId');
    const current = await this.findAssetOrThrow(tenantId, id);
    if (current.status === 'ARCHIVED') {
      throw new BadRequestException('Archived assets cannot be updated.');
    }

    const latestVersion = await this.versionRepository.findLatestByAssetId(
      tenantId,
      id,
    );
    if (!latestVersion) {
      throw new NotFoundException('Social content asset version not found.');
    }

    const aiVideoJobIds = dto.aiVideoJobIds ?? latestVersion.aiVideoJobIds;
    const requestedMediaUrls = aiVideoJobIds.length
      ? (dto.mediaUrls ?? [])
      : (dto.mediaUrls ?? latestVersion.mediaUrls);
    const mediaUrls = await this.resolveMediaUrls(
      tenantId,
      requestedMediaUrls,
      aiVideoJobIds,
    );
    const content = dto.content ?? latestVersion.content;
    const mediaType =
      dto.mediaType ??
      (dto.mediaUrls || dto.aiVideoJobIds
        ? this.inferMediaType(mediaUrls)
        : latestVersion.mediaType);
    const nextVersionNumber = await this.versionRepository.getNextVersionNumber(
      tenantId,
      id,
    );

    const version = await this.versionRepository.create({
      tenantId,
      assetId: id,
      versionNumber: nextVersionNumber,
      content,
      mediaUrls,
      aiVideoJobIds,
      mediaType,
      approvalStatus: 'PENDING',
      savedById: userId,
      changeNote: dto.changeNote,
    });

    const asset = await this.assetRepository.update(tenantId, id, {
      title: dto.title ?? current.title,
      latestVersionId: version.id,
    } as any);
    if (!asset) throw new NotFoundException('Social content asset not found');

    this.recordAssetAudit(tenantId, id, 'SOCIAL_ASSET_VERSION_CREATED', {
      actorId: userId,
      metadata: {
        versionId: version.id,
        versionNumber: nextVersionNumber,
        changeNote: dto.changeNote,
      },
    });

    return this.decorateAsset(asset, {
      latestVersion: version,
      includePublications: true,
    });
  }

  async archive(id: string): Promise<void> {
    const tenantId = this.requireTenantId();
    const current = await this.findAssetOrThrow(tenantId, id);
    if (current.status === 'ARCHIVED') return;

    const archived = await this.assetRepository.archive(tenantId, id);
    if (!archived)
      throw new NotFoundException('Social content asset not found');

    this.recordAssetAudit(tenantId, id, 'SOCIAL_ASSET_ARCHIVED', {
      actorId: this.cls.get('userId'),
    });
  }

  async getVersions(id: string): Promise<SocialContentAssetVersionEntity[]> {
    const tenantId = this.requireTenantId();
    await this.findAssetOrThrow(tenantId, id);
    return this.versionRepository.findByAssetId(tenantId, id);
  }

  async approveVersion(
    assetId: string,
    versionId: string,
  ): Promise<SocialContentAssetVersionEntity> {
    const tenantId = this.requireTenantId();
    const userId = this.cls.get('userId');
    await this.findAssetOrThrow(tenantId, assetId);
    const version = await this.findVersionForAssetOrThrow(
      tenantId,
      assetId,
      versionId,
    );

    const approved = await this.versionRepository.update(tenantId, version.id, {
      approvalStatus: 'APPROVED',
      approvedById: userId,
      approvedAt: new Date(),
      rejectionReason: undefined,
    } as any);
    if (!approved) {
      throw new NotFoundException('Social content asset version not found');
    }

    this.recordAssetAudit(tenantId, assetId, 'SOCIAL_ASSET_VERSION_APPROVED', {
      actorId: userId,
      metadata: { versionId, versionNumber: version.versionNumber },
    });

    return approved;
  }

  async rejectVersion(
    assetId: string,
    versionId: string,
    dto: RejectSocialContentAssetVersionDto,
  ): Promise<SocialContentAssetVersionEntity> {
    const tenantId = this.requireTenantId();
    const userId = this.cls.get('userId');
    await this.findAssetOrThrow(tenantId, assetId);
    const version = await this.findVersionForAssetOrThrow(
      tenantId,
      assetId,
      versionId,
    );

    const rejected = await this.versionRepository.update(tenantId, version.id, {
      approvalStatus: 'REJECTED',
      approvedById: undefined,
      approvedAt: undefined,
      rejectionReason: dto.reason,
    } as any);
    if (!rejected) {
      throw new NotFoundException('Social content asset version not found');
    }

    this.recordAssetAudit(tenantId, assetId, 'SOCIAL_ASSET_VERSION_REJECTED', {
      actorId: userId,
      metadata: {
        versionId,
        versionNumber: version.versionNumber,
        reason: dto.reason,
      },
    });

    return rejected;
  }

  async createPublications(
    assetId: string,
    dto: CreatePublicationInstancesDto,
  ): Promise<PublicationInstanceEntity[]> {
    const tenantId = this.requireTenantId();
    const userId = this.cls.get('userId');
    const asset = await this.findAssetOrThrow(tenantId, assetId);
    if (asset.status === 'ARCHIVED') {
      throw new BadRequestException('Archived assets cannot be published.');
    }

    const version = dto.versionId
      ? await this.findVersionForAssetOrThrow(tenantId, assetId, dto.versionId)
      : await this.versionRepository.findLatestByAssetId(tenantId, assetId);
    if (!version) {
      throw new NotFoundException('Approved content version not found.');
    }
    if (version.approvalStatus !== 'APPROVED') {
      throw new BadRequestException(
        'Content version must be approved before publishing.',
      );
    }

    const scheduledAt = this.parseOptionalDate(dto.scheduledAt, 'scheduledAt');
    const channels = await this.resolvePublishChannels(
      tenantId,
      dto.channelIds,
    );
    const overridesByChannelId = new Map(
      (dto.overrides ?? []).map((override) => [override.channelId, override]),
    );
    const publicationGroupId = ulid();

    const payloads = await Promise.all(
      channels.map(async (channel) => {
        const override = overridesByChannelId.get(channel.id);
        const snapshot = await this.buildPublicationSnapshot(
          tenantId,
          version,
          override,
        );
        this.validateSnapshotForPlatform(channel.type, snapshot);
        const snapshotForStorage = {
          ...snapshot,
          aiVideoJobIds: snapshot.aiVideoJobIds ?? [],
        };

        return {
          tenantId,
          assetId,
          sourceVersionId: version.id,
          publicationGroupId,
          channelId: channel.id,
          channelName: channel.name,
          channelAccount: channel.account,
          platform: channel.type as SocialContentPlatform,
          snapshot: snapshotForStorage,
          status: 'PENDING' as const,
          scheduledAt,
        };
      }),
    );

    const instances = await this.publicationRepository.createMany(payloads);
    await Promise.all(
      instances.map((instance) =>
        this.queueProducer.schedule(tenantId, instance.id, scheduledAt),
      ),
    );

    this.recordAssetAudit(tenantId, assetId, 'PUBLICATIONS_CREATED', {
      actorId: userId,
      metadata: {
        publicationGroupId,
        versionId: version.id,
        scheduledAt,
        channelIds: channels.map((channel) => channel.id),
      },
    });

    return instances;
  }

  async listPublicationInstances(query: ListPublicationInstancesQueryDto) {
    const tenantId = this.requireTenantId();
    return this.publicationRepository.findPaginated(
      {
        tenantId,
        assetId: query.assetId,
        status: query.status,
        platform: query.platform,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
      },
      Number(query.page ?? 1),
      Number(query.limit ?? 20),
    );
  }

  async updatePublicationInstance(
    instanceId: string,
    dto: UpdatePublicationInstanceDto,
  ): Promise<PublicationInstanceEntity> {
    const tenantId = this.requireTenantId();
    const instance = await this.findPublicationOrThrow(tenantId, instanceId);
    if (instance.status !== 'PENDING') {
      throw new BadRequestException(
        'Only pending publication instances can be edited.',
      );
    }

    const aiVideoJobIds =
      dto.aiVideoJobIds ?? instance.snapshot.aiVideoJobIds ?? [];
    const requestedMediaUrls = aiVideoJobIds.length
      ? (dto.mediaUrls ?? [])
      : (dto.mediaUrls ?? instance.snapshot.mediaUrls);
    const mediaUrls = await this.resolveMediaUrls(
      tenantId,
      requestedMediaUrls,
      aiVideoJobIds,
    );
    const snapshot: PublicationSnapshot = {
      content: dto.content ?? instance.snapshot.content,
      mediaUrls,
      aiVideoJobIds,
      mediaType:
        dto.mediaType ??
        (dto.mediaUrls || dto.aiVideoJobIds
          ? this.inferMediaType(mediaUrls)
          : instance.snapshot.mediaType),
    };
    this.validateSnapshotForPlatform(instance.platform, snapshot);

    const scheduledAt = dto.scheduledAt
      ? this.parseOptionalDate(dto.scheduledAt, 'scheduledAt')
      : instance.scheduledAt;
    const updated = await this.publicationRepository.update(
      tenantId,
      instanceId,
      {
        snapshot,
        scheduledAt,
      } as any,
    );
    if (!updated) throw new NotFoundException('Publication instance not found');

    if (dto.scheduledAt) {
      await this.queueProducer.schedule(tenantId, instanceId, scheduledAt);
    }

    this.recordPublicationAudit(
      tenantId,
      instanceId,
      'PUBLICATION_INSTANCE_UPDATED',
      {
        actorId: this.cls.get('userId'),
        metadata: { assetId: instance.assetId, scheduledAt },
      },
    );

    return updated;
  }

  async cancelPublicationInstance(
    instanceId: string,
  ): Promise<PublicationInstanceEntity> {
    const tenantId = this.requireTenantId();
    const instance = await this.findPublicationOrThrow(tenantId, instanceId);
    if (instance.status !== 'PENDING') {
      throw new BadRequestException(
        'Only pending publication instances can be canceled.',
      );
    }

    await this.queueProducer.cancel(instanceId);
    const canceled = await this.publicationRepository.updateStatus(
      tenantId,
      instanceId,
      'CANCELED',
    );
    if (!canceled)
      throw new NotFoundException('Publication instance not found');

    this.recordPublicationAudit(
      tenantId,
      instanceId,
      'PUBLICATION_INSTANCE_CANCELED',
      {
        actorId: this.cls.get('userId'),
        metadata: { assetId: instance.assetId },
      },
    );

    return canceled;
  }

  async retryPublicationInstance(
    instanceId: string,
  ): Promise<PublicationInstanceEntity> {
    const tenantId = this.requireTenantId();
    const instance = await this.findPublicationOrThrow(tenantId, instanceId);
    if (instance.status !== 'FAILED') {
      throw new BadRequestException(
        'Only failed publication instances can be retried.',
      );
    }

    const reset = await this.publicationRepository.resetForRetry(
      tenantId,
      instanceId,
    );
    if (!reset) throw new NotFoundException('Publication instance not found');
    await this.queueProducer.schedule(tenantId, instanceId);

    this.recordPublicationAudit(
      tenantId,
      instanceId,
      'PUBLICATION_INSTANCE_RETRIED',
      {
        actorId: this.cls.get('userId'),
        metadata: { assetId: instance.assetId },
      },
    );

    return reset;
  }

  async publishPublicationInstanceNow(
    instanceId: string,
  ): Promise<PublicationInstanceEntity> {
    const tenantId = this.requireTenantId();
    const instance = await this.findPublicationOrThrow(tenantId, instanceId);
    if (instance.status !== 'PENDING') {
      throw new BadRequestException(
        'Only pending publication instances can be published now.',
      );
    }

    const updated = await this.publicationRepository.update(
      tenantId,
      instanceId,
      {
        scheduledAt: new Date(),
      } as any,
    );
    if (!updated) throw new NotFoundException('Publication instance not found');
    await this.queueProducer.schedule(tenantId, instanceId);
    return updated;
  }

  async publishPublicationInstanceById(
    tenantId: string,
    instanceId: string,
  ): Promise<void> {
    const instance = await this.publicationRepository.findById(
      tenantId,
      instanceId,
    );
    if (!instance)
      throw new NotFoundException('Publication instance not found');
    if (['CANCELED', 'SUCCESS', 'PUBLISHING'].includes(instance.status)) return;

    await this.publicationRepository.updateStatus(
      tenantId,
      instanceId,
      'PUBLISHING',
    );

    try {
      const channel = await this.channelRepository.findByIdWithCredentials(
        tenantId,
        instance.channelId,
      );
      if (!channel || channel.status !== 'Connected') {
        throw new BadRequestException(
          `${instance.channelName} is not connected. Reconnect the channel and retry.`,
        );
      }

      const publisher = this.publisherRegistry.get(instance.platform);
      if (!publisher) {
        throw new BadRequestException(
          `No publisher strategy is registered for ${instance.platform}.`,
        );
      }

      publisher.validateContentLimits(instance.snapshot);
      const result = await publisher.publish({
        post: instance.snapshot,
        instance,
        channel,
      });
      const publishedAt = new Date();
      await this.publicationRepository.updateStatus(
        tenantId,
        instanceId,
        'SUCCESS',
        {
          publishedAt,
          platformPostId: result.platformPostId,
          platformMediaId: result.platformMediaId,
          platformResponseRaw: result.raw,
          errorCode: undefined,
          errorMessage: undefined,
        } as any,
      );

      this.recordPublicationAudit(
        tenantId,
        instanceId,
        'PUBLICATION_INSTANCE_SUCCEEDED',
        {
          metadata: {
            assetId: instance.assetId,
            channelId: instance.channelId,
            platform: instance.platform,
            platformPostId: result.platformPostId,
          },
        },
      );
    } catch (error) {
      const normalized = normalizePublisherError(error);
      this.logger.error(
        `Publication instance ${instance.id} failed: [${normalized.code}] ${normalized.message}`,
      );

      await this.publicationRepository.incrementRetry(
        tenantId,
        instance.id,
        normalized.code,
        normalized.message,
      );

      if (normalized.isAuthError) {
        await this.channelRepository.update(tenantId, instance.channelId, {
          status: 'Error',
        });
      }

      this.recordPublicationAudit(
        tenantId,
        instanceId,
        'PUBLICATION_INSTANCE_FAILED',
        {
          metadata: {
            assetId: instance.assetId,
            channelId: instance.channelId,
            platform: instance.platform,
            errorCode: normalized.code,
            errorMessage: normalized.message,
          },
        },
      );
    }
  }

  private async decorateAsset(
    asset: SocialContentAssetEntity,
    options: {
      latestVersion?: SocialContentAssetVersionEntity;
      includePublications: boolean;
    },
  ): Promise<SocialContentAssetWithDetails> {
    const [latestVersion, publications] = await Promise.all([
      this.resolveLatestVersion(asset, options.latestVersion),
      this.publicationRepository.findByAssetId(asset.tenantId, asset.id),
    ]);

    return {
      ...asset,
      latestVersion: latestVersion ?? undefined,
      publicationCounts: this.countPublications(publications),
      publications: options.includePublications ? publications : undefined,
    };
  }

  /** Resolve the latest version: prefer provided → lookup by ID → fallback to latest. */
  private resolveLatestVersion(
    asset: SocialContentAssetEntity,
    provided?: SocialContentAssetVersionEntity,
  ): Promise<SocialContentAssetVersionEntity | null> {
    if (provided) {
      return Promise.resolve(provided);
    }
    if (asset.latestVersionId) {
      return this.versionRepository.findById(
        asset.tenantId,
        asset.latestVersionId,
      );
    }
    return this.versionRepository.findLatestByAssetId(asset.tenantId, asset.id);
  }

  private countPublications(publications: PublicationInstanceEntity[]) {
    return {
      pending: publications.filter((item) => item.status === 'PENDING').length,
      publishing: publications.filter((item) => item.status === 'PUBLISHING')
        .length,
      success: publications.filter((item) => item.status === 'SUCCESS').length,
      failed: publications.filter((item) => item.status === 'FAILED').length,
      canceled: publications.filter((item) => item.status === 'CANCELED')
        .length,
    };
  }

  private async buildPublicationSnapshot(
    tenantId: string,
    version: SocialContentAssetVersionEntity,
    override?: {
      content?: string;
      mediaUrls?: string[];
      aiVideoJobIds?: string[];
      mediaType?: SocialContentMediaType;
    },
  ): Promise<PublicationSnapshot> {
    const aiVideoJobIds =
      override?.aiVideoJobIds ?? version.aiVideoJobIds ?? [];
    const requestedMediaUrls = aiVideoJobIds.length
      ? (override?.mediaUrls ?? [])
      : (override?.mediaUrls ?? version.mediaUrls);
    const mediaUrls = await this.resolveMediaUrls(
      tenantId,
      requestedMediaUrls,
      aiVideoJobIds,
    );
    return {
      content: override?.content ?? version.content,
      mediaUrls,
      aiVideoJobIds,
      mediaType:
        override?.mediaType ??
        (override?.mediaUrls || override?.aiVideoJobIds
          ? this.inferMediaType(mediaUrls)
          : version.mediaType),
    };
  }

  private async resolveMediaUrls(
    tenantId: string,
    mediaUrls: string[],
    aiVideoJobIds: string[],
  ): Promise<string[]> {
    if (aiVideoJobIds.length === 0) {
      return mediaUrls;
    }
    if (mediaUrls.length > 0) {
      throw new BadRequestException(
        'Choose either direct media URLs or one system video, not both.',
      );
    }
    if (aiVideoJobIds.length > 1) {
      throw new BadRequestException('Only one system video can be attached.');
    }
    return this.aiVideoJobService.resolveApprovedVideoUrls(
      tenantId,
      aiVideoJobIds,
    );
  }

  private validateSnapshotForPlatform(
    platform: string,
    snapshot: PublicationSnapshot,
  ) {
    const publisher = this.publisherRegistry.get(platform);
    if (!publisher) {
      throw new BadRequestException(
        `No publisher strategy is registered for ${platform}.`,
      );
    }
    publisher.validateContentLimits(snapshot);
  }

  private async resolvePublishChannels(
    tenantId: string,
    channelIds: string[],
  ): Promise<Channel[]> {
    const uniqueIds = [...new Set(channelIds)];
    const channels = await Promise.all(
      uniqueIds.map((id) =>
        this.channelRepository.findByIdWithCredentials(tenantId, id),
      ),
    );

    const missingIndex = channels.findIndex((channel) => !channel);
    if (missingIndex !== -1) {
      throw new BadRequestException(
        `Channel ${uniqueIds[missingIndex]} was not found.`,
      );
    }

    const resolved = channels as Channel[];
    const notConnected = resolved.find(
      (channel) => channel.status !== 'Connected',
    );
    if (notConnected) {
      throw new BadRequestException(
        `${notConnected.name} is not connected and cannot be used for publishing.`,
      );
    }

    const unsupported = resolved.find(
      (channel) =>
        !SOCIAL_CONTENT_PLATFORMS.includes(
          channel.type as SocialContentPlatform,
        ),
    );
    if (unsupported) {
      throw new BadRequestException(
        `${unsupported.type} is not supported by Social Content Library yet.`,
      );
    }

    return resolved;
  }

  private inferMediaType(mediaUrls: string[]): SocialContentMediaType {
    if (mediaUrls.length === 0) return 'text';
    const imageCount = mediaUrls.filter((url) =>
      /\.(apng|avif|gif|jpe?g|png|webp)(\?.*)?$/i.test(url),
    ).length;
    const videoCount = mediaUrls.filter((url) =>
      /\.(m4v|mov|mp4|mpeg|webm)(\?.*)?$/i.test(url),
    ).length;
    if (videoCount === mediaUrls.length) return 'video';
    if (imageCount === mediaUrls.length) return 'image';
    return 'mixed';
  }

  private parseOptionalDate(value: string | undefined, field: string) {
    if (!value) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${field} must be a valid date.`);
    }
    return date;
  }

  private resolveTitle(
    title: string | undefined,
    content: string,
    mediaUrls: string[],
  ): string {
    const trimmed = title?.trim();
    if (trimmed) return trimmed;
    const firstLine = content.trim().split('\n')[0]?.trim();
    if (firstLine) return firstLine.slice(0, 80);
    return mediaUrls.length > 0
      ? `Media asset (${mediaUrls.length})`
      : 'Untitled asset';
  }

  private async findAssetOrThrow(
    tenantId: string,
    assetId: string,
  ): Promise<SocialContentAssetEntity> {
    const asset = await this.assetRepository.findById(tenantId, assetId);
    if (!asset) throw new NotFoundException('Social content asset not found');
    return asset;
  }

  private async findVersionForAssetOrThrow(
    tenantId: string,
    assetId: string,
    versionId: string,
  ): Promise<SocialContentAssetVersionEntity> {
    const version = await this.versionRepository.findById(tenantId, versionId);
    if (!version || version.assetId !== assetId) {
      throw new NotFoundException('Social content asset version not found');
    }
    return version;
  }

  private async findPublicationOrThrow(
    tenantId: string,
    instanceId: string,
  ): Promise<PublicationInstanceEntity> {
    const instance = await this.publicationRepository.findById(
      tenantId,
      instanceId,
    );
    if (!instance)
      throw new NotFoundException('Publication instance not found');
    return instance;
  }

  private requireTenantId(): string {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) throw new BadRequestException('Tenant context is required.');
    return tenantId;
  }

  private recordAssetAudit(
    tenantId: string,
    assetId: string,
    action: string,
    options: {
      actorId?: string;
      metadata?: Record<string, any>;
    } = {},
  ): void {
    this.eventEmitter.emit('activity.create', {
      tenantId,
      targetType: 'social_content_asset',
      targetId: assetId,
      event: action,
      actorId: options.actorId,
      payload: options.metadata,
    });
  }

  private recordPublicationAudit(
    tenantId: string,
    instanceId: string,
    action: string,
    options: {
      actorId?: string;
      metadata?: Record<string, any>;
    } = {},
  ): void {
    this.eventEmitter.emit('activity.create', {
      tenantId,
      targetType: 'publication_instance',
      targetId: instanceId,
      event: action,
      actorId: options.actorId,
      payload: options.metadata,
    });
  }
}
