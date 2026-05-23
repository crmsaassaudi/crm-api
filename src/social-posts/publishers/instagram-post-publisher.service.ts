import { BadRequestException, Injectable } from '@nestjs/common';
import axios from 'axios';
import { BasePublisher, PublishContext, PublishResult } from './base-publisher';

const META_GRAPH_API_VERSION = 'v20.0';

@Injectable()
export class InstagramPostPublisher extends BasePublisher {
  readonly platform = 'instagram' as const;

  validateContentLimits({
    content,
    mediaUrls,
    mediaType,
  }: PublishContext['post']): void {
    this.ensureContentOrMedia({ content, mediaUrls, mediaType });
    if (content.length > 2200) {
      throw new BadRequestException(
        'Instagram captions support up to 2,200 characters.',
      );
    }
    if (mediaType === 'text') {
      throw new BadRequestException(
        'Instagram publishing requires image or video media.',
      );
    }
    if (mediaUrls.length !== 1) {
      throw new BadRequestException(
        'Instagram MVP publishing supports one image or one Reel video per post.',
      );
    }
  }

  async publish(context: PublishContext): Promise<PublishResult> {
    this.validateContentLimits(context.post);
    const accessToken = this.getAccessToken(context.channel);
    const instagramAccountId = context.channel.account;
    const { post } = context;
    const mediaUrl = this.toPublicMediaUrl(post.mediaUrls[0]);

    const createResponse = await axios.post(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${instagramAccountId}/media`,
      null,
      {
        params: {
          caption: post.content,
          access_token: accessToken,
          ...(post.mediaType === 'video'
            ? { media_type: 'REELS', video_url: mediaUrl }
            : { image_url: mediaUrl }),
        },
      },
    );

    const creationId = createResponse.data.id;
    const publishResponse = await axios.post(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${instagramAccountId}/media_publish`,
      null,
      {
        params: {
          creation_id: creationId,
          access_token: accessToken,
        },
      },
    );

    return {
      platformPostId: publishResponse.data.id,
      platformMediaId: creationId,
      raw: {
        container: createResponse.data,
        publish: publishResponse.data,
      },
    };
  }
}
