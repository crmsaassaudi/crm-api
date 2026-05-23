import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { ChannelRepository } from '../../channels/infrastructure/persistence/document/repositories/channel.repository';
import { Channel } from '../../channels/domain/channel';
import {
  CreateSocialPostDto,
  ListSocialPostTasksQueryDto,
  ListSocialPostsQueryDto,
  RejectSocialPostDto,
  ScheduleSocialPostDto,
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
    const channels = await this.resolvePublishChannels(
      tenantId,
      dto.channelIds,
    );
    const mediaUrls = dto.mediaUrls ?? [];
    const mediaType = dto.mediaType ?? this.inferMediaType(mediaUrls);
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : undefined;
    const status: SocialPostStatus = scheduledAt ? 'SCHEDULED' : 'DRAFT';

    const post = await this.postRepository.create({
      tenantId,
      content: dto.content,
      mediaUrls,
      mediaType,
      status,
      scheduledAt,
      approvalStatus: dto.approvalStatus ?? 'PENDING',
      createdById: userId,
    });

    const tasks = await this.taskRepository.createMany(
      this.buildTaskPayloads(tenantId, post, channels),
    );

    await this.recordAudit(tenantId, post.id, 'SOCIAL_POST_CREATED', {
      actorId: userId,
      newStatus: post.status,
      metadata: {
        channelIds: channels.map((channel) => channel.id),
        scheduledAt,
      },
    });

    if (post.status === 'SCHEDULED' && post.approvalStatus === 'APPROVED') {
      await this.queueProducer.schedule(tenantId, post.id, scheduledAt!);
    }

    return { ...post, tasks };
  }

  async findPaginated(query: ListSocialPostsQueryDto) {
    const tenantId = this.requireTenantId();
    return this.postRepository.findPaginated(
      {
        tenantId,
        status: query.status,
        approvalStatus: query.approvalStatus,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
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

    if (current.status === 'PUBLISHING' || current.status === 'COMPLETED') {
      throw new BadRequestException(
        `Cannot edit a post in ${current.status} status.`,
      );
    }

    const mediaUrls = dto.mediaUrls ?? current.mediaUrls;
    const update: Partial<SocialPostEntity> = {
      content: dto.content ?? current.content,
      mediaUrls,
      mediaType: dto.mediaType ?? this.inferMediaType(mediaUrls),
      scheduledAt: dto.scheduledAt
        ? new Date(dto.scheduledAt)
        : current.scheduledAt,
    };

    if (dto.scheduledAt) {
      update.status = 'SCHEDULED';
    }

    const post = await this.postRepository.update(tenantId, id, update as any);
    if (!post) throw new NotFoundException('Social post not found');

    let tasks = await this.taskRepository.findByPostId(tenantId, id);
    if (dto.channelIds) {
      const channels = await this.resolvePublishChannels(
        tenantId,
        dto.channelIds,
      );
      tasks = await this.taskRepository.replaceForPost(
        tenantId,
        id,
        this.buildTaskPayloads(tenantId, post, channels),
      );
    } else if (post.scheduledAt) {
      await Promise.all(
        tasks.map((task) =>
          this.taskRepository.update(tenantId, task.id, {
            scheduledAt: post.scheduledAt,
          }),
        ),
      );
      tasks = await this.taskRepository.findByPostId(tenantId, id);
    }

    await this.recordAudit(tenantId, id, 'SOCIAL_POST_UPDATED', {
      actorId: this.cls.get('userId'),
      oldStatus: current.status,
      newStatus: post.status,
    });

    if (post.status === 'SCHEDULED' && post.approvalStatus === 'APPROVED') {
      await this.queueProducer.schedule(tenantId, id, post.scheduledAt!);
    }

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
      await this.queueProducer.schedule(tenantId, id, post.scheduledAt);
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

  async schedule(
    id: string,
    dto: ScheduleSocialPostDto,
  ): Promise<SocialPostWithTasks> {
    const tenantId = this.requireTenantId();
    const scheduledAt = new Date(dto.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('scheduledAt must be a valid date.');
    }

    const current = await this.findPostOrThrow(tenantId, id);
    if (current.status === 'PUBLISHING' || current.status === 'COMPLETED') {
      throw new BadRequestException(
        `Cannot schedule a post in ${current.status} status.`,
      );
    }

    const post = await this.postRepository.updateStatus(
      tenantId,
      id,
      'SCHEDULED',
      {
        scheduledAt,
      } as any,
    );
    if (!post) throw new NotFoundException('Social post not found');

    const tasks = await this.taskRepository.findByPostId(tenantId, id);
    await Promise.all(
      tasks.map((task) =>
        this.taskRepository.update(tenantId, task.id, { scheduledAt }),
      ),
    );

    await this.recordAudit(tenantId, id, 'SOCIAL_POST_SCHEDULED', {
      actorId: this.cls.get('userId'),
      oldStatus: current.status,
      newStatus: 'SCHEDULED',
      metadata: { scheduledAt },
    });

    if (post.approvalStatus === 'APPROVED') {
      await this.queueProducer.schedule(tenantId, id, scheduledAt);
    }

    return this.findById(id);
  }

  async publishNow(id: string): Promise<SocialPostWithTasks> {
    const tenantId = this.requireTenantId();
    await this.publishPostById(tenantId, id);
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
    await this.publishPostById(tenantId, task.postId, taskId);
    return this.findById(task.postId);
  }

  async publishPostById(
    tenantId: string,
    postId: string,
    onlyTaskId?: string,
  ): Promise<void> {
    const post = await this.findPostOrThrow(tenantId, postId);
    if (post.approvalStatus !== 'APPROVED') {
      throw new BadRequestException(
        'Social post must be approved before publishing.',
      );
    }

    const allTasks = await this.taskRepository.findByPostId(tenantId, postId);
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

    const finalTasks = await this.taskRepository.findByPostId(tenantId, postId);
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

      const result = await publisher.publish({ post, task, channel });
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
  ) {
    return channels.map((channel) => ({
      tenantId,
      postId: post.id,
      channelId: channel.id,
      channelName: channel.name,
      channelAccount: channel.account,
      platform: channel.type as SocialPostPlatform,
      status: 'PENDING' as const,
      scheduledAt: post.scheduledAt,
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
