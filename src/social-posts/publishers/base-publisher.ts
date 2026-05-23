import { BadRequestException } from '@nestjs/common';
import { Channel } from '../../channels/domain/channel';
import { PublicationInstanceEntity } from '../repositories/social-post-task.repository';
import {
  PublicationSnapshot,
  SocialContentPlatform,
} from '../social-posts.types';

export interface PublishContext {
  post: PublicationSnapshot;
  instance: PublicationInstanceEntity;
  channel: Channel;
}

export interface PublishResult {
  platformPostId?: string;
  platformMediaId?: string;
  raw?: Record<string, any>;
}

export abstract class BasePublisher {
  abstract readonly platform: SocialContentPlatform;

  abstract publish(context: PublishContext): Promise<PublishResult>;

  abstract validateContentLimits(post: PublicationSnapshot): void;

  protected getAccessToken(channel: Channel): string {
    const accessToken = channel.credentials?.accessToken;
    if (!accessToken) {
      throw new BadRequestException(
        `${channel.name} is connected but has no access token available.`,
      );
    }
    return accessToken;
  }

  protected ensureContentOrMedia(post: PublicationSnapshot): void {
    if (!post.content.trim() && post.mediaUrls.length === 0) {
      throw new BadRequestException('Post content or media is required.');
    }
  }
}
