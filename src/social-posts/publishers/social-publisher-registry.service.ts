import { Injectable } from '@nestjs/common';
import { BasePublisher } from './base-publisher';
import { FacebookPostPublisher } from './facebook-post-publisher.service';
import { InstagramPostPublisher } from './instagram-post-publisher.service';
import { TikTokPostPublisher } from './tiktok-post-publisher.service';
import { SocialPostPlatform } from '../social-posts.types';

@Injectable()
export class SocialPublisherRegistry {
  private readonly publishers = new Map<SocialPostPlatform, BasePublisher>();

  constructor(
    facebook: FacebookPostPublisher,
    instagram: InstagramPostPublisher,
    tiktok: TikTokPostPublisher,
  ) {
    [facebook, instagram, tiktok].forEach((publisher) => {
      this.publishers.set(publisher.platform, publisher);
    });
  }

  get(platform: string): BasePublisher | null {
    return this.publishers.get(platform as SocialPostPlatform) ?? null;
  }
}
