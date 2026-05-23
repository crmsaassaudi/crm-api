import { BadRequestException } from '@nestjs/common';
import { Channel } from '../../channels/domain/channel';
import { SocialPostEntity } from '../repositories/social-post.repository';
import { SocialPostTaskEntity } from '../repositories/social-post-task.repository';
import { SocialPostPlatform } from '../social-posts.types';

export interface PublishContext {
  post: SocialPostEntity;
  task: SocialPostTaskEntity;
  channel: Channel;
}

export interface PublishResult {
  platformPostId?: string;
  platformMediaId?: string;
  raw?: Record<string, any>;
}

export abstract class BasePublisher {
  abstract readonly platform: SocialPostPlatform;

  abstract publish(context: PublishContext): Promise<PublishResult>;

  abstract validateContentLimits(post: SocialPostEntity): void;

  protected getAccessToken(channel: Channel): string {
    const accessToken = channel.credentials?.accessToken;
    if (!accessToken) {
      throw new BadRequestException(
        `${channel.name} is connected but has no access token available.`,
      );
    }
    return accessToken;
  }

  protected ensureContentOrMedia(post: SocialPostEntity): void {
    if (!post.content.trim() && post.mediaUrls.length === 0) {
      throw new BadRequestException('Post content or media is required.');
    }
  }
}
