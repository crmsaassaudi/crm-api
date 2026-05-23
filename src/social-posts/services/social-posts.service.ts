import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ulid } from 'ulid';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { ChannelRepository } from '../../channels/infrastructure/persistence/document/repositories/channel.repository';
import { Channel } from '../../channels/domain/channel';
import {
  CreateSocialPostDto,
  ListSocialPostTasksQueryDto,
  ListSocialPostsQueryDto,
  PublishSocialPostDto,
  RejectSocialPostDto,
  UpdateSocialPostDto,
} from '../dto/social-post.dto';
import {
  SocialPostEntity,
  SocialPostRepository,
} from '../repositories/social-post.repository';
import {
  SocialPostTaskEntity,
  SocialPostTaskRepository,
} from '../repositories/social-post-task.repository';
import { SocialPublisherRegistry } from '../publishers/social-publisher-registry.service';
import { normalizePublisherError } from '../publishers/publisher-error.util';
import {
  SOCIAL_POST_PLATFORMS,
  SocialPostMediaType,
  SocialPostPlatform,
  SocialPostStatus,
} from '../social-posts.types';
import { SocialPostQueueProducer } from './social-post-queue.producer';

export interface SocialPostWithTasks extends SocialPostEntity {
  tasks?: SocialPostTaskEntity[];
}

@Injectable()
export class SocialPostsService {
  private readonly logger = new Logger(SocialPostsService.name);

  constructor(
    private readonly postRepository: SocialPostRepository,
    private readonly taskRepository: SocialPostTaskRepository,
    private readonly channelRepository: ChannelRepository,
    private readonly publisherRegistry: SocialPublisherRegistry,
    private readonly queueProducer: SocialPostQueueProducer,
    private readonly auditLogService: AuditLogService,
    private readonly cls: ClsService,
  ) {}

  async create(dto: CreateSocialPostDto): Promise<SocialPostWithTasks> {
    const tenantId = this.requireTenantId();
    const userId = this.cls.get('userId');
    const mediaUrls = dto.mediaUrls ?? [];
    const mediaType = dto.mediaType ?? this.inferMediaType(mediaUrls);

    const post = await this.postRepository.create({
      tenantId,
      content: dto.content,
      mediaUrls,
      mediaType,
      status: 'DRAFT',
      approvalStatus: 'PENDING',
      createdById: userId,
    });

    await this.recordAudit(tenantId, post.id, 'SOCIAL_POST_CREATED', {
      actorId: userId,
      newStatus: post.status,
    });

    return { ...post, tasks: [] };
  }

  async findPaginated(query: ListSocialPostsQueryDto) {
    const tenantId = this.requireTenantId();
    return this.postRepository.findPaginated(
      {
        tenantId,
        status: query.status,
      },
      Number(query.page ?? 1),
      Number(query.limit ?? 20),
    );
  }

  async findById(id: string): Promise<SocialPostWithTasks> {
    const tenantId = this.requireTenantId();
    const post = await this.findPostOrThrow(tenantId, id);
    const tasks = await this.taskRepository.findByPostId(tenantId, id);
    return { ...post, tasks };
  }

  async listTasks(query: ListSocialPostTasksQueryDto) {
    const tenantId = this.requireTenantId();
    return this.taskRepository.findPaginated(
      {
        tenantId,
        status: query.status,
        platform: query.platform,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
      },
      Number(query.page ?? 1),
      Number(query.limit ?? 20),
    );
  }

  async update(
    id: string,
    dto: UpdateSocialPostDto,
  ): Promise<SocialPostWithTasks> {
    const tenantId = this.requireTenantId();
    const current = await this.findPostOrThrow(tenantId, id);

    const mediaUrls = dto.mediaUrls ?? current.mediaUrls;
    const update: Partial<SocialPostEntity> = {
      content: dto.content ?? current.content,
      mediaUrls,
      mediaType: dto.mediaType ?? this.inferMediaType(mediaUrls),
    };

    const post = await this.postRepository.update(tenantId, id, update as any);
    if (!post) throw new NotFoundException('Social post not found');

    await this.recordAudit(tenantId, id, 'SOCIAL_POST_UPDATED', {
      actorId: this.cls.get('userId'),
      oldStatus: current.status,
      newStatus: post.status,
    });

    const tasks = await this.taskRepository.findByPostId(tenantId, id);
    return { ...post, tasks };
  }

  async approve(id: string): Promise<SocialPostWithTasks> {
    const tenantId = this.requireTenantId();
    const userId = this.cls.get('userId');
    const current = await this.findPostOrThrow(tenantId, id);
    if (current.approvalStatus === 'REJECTED') {
      throw new BadRequestException('Rejected posts cannot be approved again.');
    }

    const post = await this.postRepository.update(tenantId, id, {
      approvalStatus: 'APPROVED',
      approvedById: userId,
      approvedAt: new Date(),
    } as any);
    if (!post) throw new NotFoundException('Social post not found');

    await this.recordAudit(tenantId, id, 'SOCIAL_POST_APPROVED', {
      actorId: userId,
      oldStatus: current.status,
      newStatus: post.status,
    });

    if (post.status === 'SCHEDULED' && post.scheduledAt) {
      const scheduledTasks = await this.taskRepository.findByPostId(tenantId, id);
      const batchIds = [...new Set(scheduledTasks.map((task) => task.batchId))];
      await Promise.all(
        batchIds.map((batchId) =>
          this.queueProducer.schedule(tenantId, id, batchId, post.scheduledAt!),
        ),
      );
    }

    return this.findById(id);
  }

  async reject(
    id: string,
    dto: RejectSocialPostDto,
  ): Promise<SocialPostWithTasks> {
    const tenantId = this.requireTenantId();
    const current = await this.findPostOrThrow(tenantId, id);
    if (current.status === 'PUBLISHING' || current.status === 'COMPLETED') {
      throw new BadRequestException(
        `Cannot reject a post in ${current.status} status.`,
      );
    }

    const post = await this.postRepository.update(tenantId, id, {
      approvalStatus: 'REJECTED',
      errorSummary: dto.reason,
    } as any);
    if (!post) throw new NotFoundException('Social post not found');

    await this.recordAudit(tenantId, id, 'SOCIAL_POST_REJECTED', {
      actorId: this.cls.get('userId'),
      oldStatus: current.status,
      newStatus: post.status,
      metadata: { reason: dto.reason },
    });

    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    const tenantId = this.requireTenantId();
    const current = await this.findPostOrThrow(tenantId, id);
    const activeTasks = (await this.taskRepository.findByPostId(tenantId, id))
      .filter((task) => task.status === 'PUBLISHING');
    if (activeTasks.length > 0) {
      throw new BadRequestException('Cannot delete a post while it is publishing.');
    }

    await this.taskRepository.deleteForPost(tenantId, id);
    const deleted = await this.postRepository.delete(tenantId, id);
    if (!deleted) throw new NotFoundException('Social post not found');

    await this.recordAudit(tenantId, id, 'SOCIAL_POST_DELETED', {
      actorId: this.cls.get('userId'),
      oldStatus: current.status,
    });
  }

  async publish(
    id: string,
    dto: PublishSocialPostDto,
  ): Promise<SocialPostWithTasks> {
    const tenantId = this.requireTenantId();
    const userId = this.cls.get('userId');
    const current = await this.findPostOrThrow(tenantId, id);
    if (!current.content.trim() && current.mediaUrls.length === 0) {
      throw new BadRequestException('Add content or media before publishing.');
    }

    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : undefined;
    if (dto.scheduledAt && Number.isNaN(scheduledAt?.getTime())) {
      throw new BadRequestException('scheduledAt must be a valid date.');
    }

    const channels = await this.resolvePublishChannels(tenantId, dto.channelIds);
    const batchId = ulid();
    const tasks = await this.taskRepository.createMany(
      this.buildTaskPayloads(tenantId, current, channels, batchId, scheduledAt),
    );

    const post = await this.postRepository.update(tenantId, id, {
      status: scheduledAt ? 'SCHEDULED' : 'DRAFT',
      approvalStatus: 'APPROVED',
      approvedById: userId,
      approvedAt: new Date(),
      scheduledAt,
    } as any);
    if (!post) throw new NotFoundException('Social post not found');

    await this.recordAudit(tenantId, id, 'SOCIAL_POST_PUBLISH_REQUESTED', {
      actorId: userId,
      oldStatus: current.status,
      newStatus: scheduledAt ? 'SCHEDULED' : 'PENDING',
      metadata: {
        batchId,
        channelIds: channels.map((channel) => channel.id),
        scheduledAt,
      },
    });

    if (scheduledAt) {
      await this.queueProducer.schedule(tenantId, id, batchId, scheduledAt);
    } else {
      await this.publishPostById(tenantId, id, batchId);
    }

    return this.findById(id);
  }

  async schedule(
    id: string,
    dto: PublishSocialPostDto,
  ): Promise<SocialPostWithTasks> {
    if (!dto.scheduledAt) {
      throw new BadRequestException('scheduledAt is required.');
    }
    return this.publish(id, dto);
  }

  async publishNow(
    id: string,
    dto: PublishSocialPostDto,
  ): Promise<SocialPostWithTasks> {
    return this.publish(id, { ...dto, scheduledAt: undefined });
  }

  async legacyPublishNow(id: string): Promise<SocialPostWithTasks> {
    const tenantId = this.requireTenantId();
    const tasks = await this.taskRepository.findByPostId(tenantId, id);
    if (tasks.length === 0) {
      throw new BadRequestException(
        'Select channels before publishing this post.',
      );
    }
    await this.publishPostById(tenantId, id, tasks[0].batchId);
    return this.findById(id);
  }

  async retryTask(taskId: string): Promise<SocialPostWithTasks> {
    const tenantId = this.requireTenantId();
    const task = await this.taskRepository.findById(tenantId, taskId);
    if (!task) throw new NotFoundException('Social post task not found');
    if (task.status !== 'FAILED') {
      throw new BadRequestException('Only failed tasks can be retried.');
    }
    await this.taskRepository.resetForRetry(tenantId, taskId);
    await this.publishPostById(tenantId, task.postId, task.batchId, taskId);
    return this.findById(task.postId);
  }

  async publishPostById(
    tenantId: string,
    postId: string,
    batchId: string,
    onlyTaskId?: string,
  ): Promise<void> {
    const post = await this.findPostOrThrow(tenantId, postId);
    if (post.approvalStatus !== 'APPROVED') {
      throw new BadRequestException(
        'Social post must be approved before publishing.',
      );
    }

    const allTasks = await this.taskRepository.findByBatchId(tenantId, batchId);
    const tasksToRun = allTasks.filter((task) => {
      if (onlyTaskId) return task.id === onlyTaskId;
      return task.status !== 'SUCCESS';
    });

    if (tasksToRun.length === 0) return;

    await this.postRepository.updateStatus(tenantId, postId, 'PUBLISHING');
    await this.recordAudit(tenantId, postId, 'SOCIAL_POST_PUBLISH_STARTED', {
      oldStatus: post.status,
      newStatus: 'PUBLISHING',
    });

    await Promise.all(
      tasksToRun.map((task) => this.publishTask(tenantId, post, task)),
    );

    const finalTasks = await this.taskRepository.findByBatchId(
      tenantId,
      batchId,
    );
    const successCount = finalTasks.filter(
      (task) => task.status === 'SUCCESS',
    ).length;
    const failedTasks = finalTasks.filter((task) => task.status === 'FAILED');
    const nextStatus: SocialPostStatus =
      successCount === finalTasks.length
        ? 'COMPLETED'
        : successCount > 0
          ? 'PARTIALLY_FAILED'
          : 'FAILED';

    await this.postRepository.updateStatus(tenantId, postId, nextStatus, {
      publishedAt: successCount > 0 ? new Date() : undefined,
      errorSummary:
        failedTasks.length > 0
          ? failedTasks
              .map((task) => `${task.channelName}: ${task.errorMessage}`)
              .join('\n')
          : undefined,
    } as any);

    await this.recordAudit(tenantId, postId, 'SOCIAL_POST_PUBLISH_FINISHED', {
      oldStatus: 'PUBLISHING',
      newStatus: nextStatus,
      metadata: {
        successCount,
        failedCount: failedTasks.length,
      },
    });
  }

  private async publishTask(
    tenantId: string,
    post: SocialPostEntity,
    task: SocialPostTaskEntity,
  ): Promise<void> {
    await this.taskRepository.updateStatus(tenantId, task.id, 'PUBLISHING');
    try {
      const channel = await this.channelRepository.findByIdWithCredentials(
        tenantId,
        task.channelId,
      );
      if (!channel || channel.status !== 'Connected') {
        throw new BadRequestException(
          `${task.channelName} is not connected. Reconnect the channel and retry.`,
        );
      }

      const publisher = this.publisherRegistry.get(task.platform);
      if (!publisher) {
        throw new BadRequestException(
          `No publisher strategy is registered for ${task.platform}.`,
        );
      }

      const postSnapshot: SocialPostEntity = {
        ...post,
        content: task.postContent ?? post.content,
        mediaUrls: task.postMediaUrls ?? post.mediaUrls,
        mediaType: task.postMediaType ?? post.mediaType,
      };

      const result = await publisher.publish({ post: postSnapshot, task, channel });
      await this.taskRepository.updateStatus(tenantId, task.id, 'SUCCESS', {
        publishedAt: new Date(),
        platformPostId: result.platformPostId,
        platformMediaId: result.platformMediaId,
        platformResponseRaw: result.raw,
        errorCode: undefined,
        errorMessage: undefined,
      } as any);

      await this.recordAudit(tenantId, post.id, 'SOCIAL_POST_TASK_SUCCEEDED', {
        metadata: {
          taskId: task.id,
          channelId: task.channelId,
          platform: task.platform,
          platformPostId: result.platformPostId,
        },
      });
    } catch (error) {
      const normalized = normalizePublisherError(error);
      this.logger.error(
        `Social post task ${task.id} failed: [${normalized.code}] ${normalized.message}`,
      );

      await this.taskRepository.incrementRetry(
        tenantId,
        task.id,
        normalized.code,
        normalized.message,
      );

      if (normalized.isAuthError) {
        await this.channelRepository.update(tenantId, task.channelId, {
          status: 'Error',
        });
      }

      await this.recordAudit(tenantId, post.id, 'SOCIAL_POST_TASK_FAILED', {
        metadata: {
          taskId: task.id,
          channelId: task.channelId,
          platform: task.platform,
          errorCode: normalized.code,
          errorMessage: normalized.message,
        },
      });
    }
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
        !SOCIAL_POST_PLATFORMS.includes(channel.type as SocialPostPlatform),
    );
    if (unsupported) {
      throw new BadRequestException(
        `${unsupported.type} is not supported by Social Post Management yet.`,
      );
    }

    return resolved;
  }

  private buildTaskPayloads(
    tenantId: string,
    post: SocialPostEntity,
    channels: Channel[],
    batchId: string,
    scheduledAt?: Date,
  ) {
    return channels.map((channel) => ({
      tenantId,
      postId: post.id,
      batchId,
      channelId: channel.id,
      channelName: channel.name,
      channelAccount: channel.account,
      postContent: post.content,
      postMediaUrls: post.mediaUrls,
      postMediaType: post.mediaType,
      platform: channel.type as SocialPostPlatform,
      status: 'PENDING' as const,
      scheduledAt,
    }));
  }

  private inferMediaType(mediaUrls: string[]): SocialPostMediaType {
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

  private async findPostOrThrow(
    tenantId: string,
    postId: string,
  ): Promise<SocialPostEntity> {
    const post = await this.postRepository.findById(tenantId, postId);
    if (!post) throw new NotFoundException('Social post not found');
    return post;
  }

  private requireTenantId(): string {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) throw new BadRequestException('Tenant context is required.');
    return tenantId;
  }

  private async recordAudit(
    tenantId: string,
    postId: string,
    action: string,
    options: {
      actorId?: string;
      oldStatus?: string;
      newStatus?: string;
      metadata?: Record<string, any>;
    } = {},
  ): Promise<void> {
    await this.auditLogService.record({
      tenantId,
      action,
      targetEntityType: 'social_post',
      targetEntityId: postId,
      actorId: options.actorId,
      metadata: {
        oldStatus: options.oldStatus,
        newStatus: options.newStatus,
        ...options.metadata,
      },
    });
  }
}
