import { BadRequestException, Injectable } from '@nestjs/common';
import { BasePublisher, PublishContext, PublishResult } from './base-publisher';

@Injectable()
export class TikTokPostPublisher extends BasePublisher {
  readonly platform = 'tiktok' as const;

  validateContentLimits({
    content,
    mediaUrls,
    mediaType,
  }: PublishContext['post']): void {
    this.ensureContentOrMedia({ content, mediaUrls, mediaType });
    if (content.length > 2200) {
      throw new BadRequestException(
        'TikTok captions support up to 2,200 characters.',
      );
    }
    if (mediaType !== 'video' || mediaUrls.length !== 1) {
      throw new BadRequestException(
        'TikTok publishing requires exactly one video.',
      );
    }
  }

  publish(context: PublishContext): Promise<PublishResult> {
    this.validateContentLimits(context.post);
    throw new BadRequestException(
      'TikTok publishing adapter is not connected yet. Configure the TikTok Content Posting API credential contract before enabling this task.',
    );
  }
}
