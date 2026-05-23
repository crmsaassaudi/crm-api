import { BadRequestException, Injectable } from '@nestjs/common';
import axios from 'axios';
import { BasePublisher, PublishContext, PublishResult } from './base-publisher';

const META_GRAPH_API_VERSION = 'v20.0';

@Injectable()
export class FacebookPostPublisher extends BasePublisher {
  readonly platform = 'facebook' as const;

  validateContentLimits({
    content,
    mediaUrls,
    mediaType,
  }: PublishContext['post']): void {
    this.ensureContentOrMedia({ content, mediaUrls, mediaType });
    if (content.length > 63206) {
      throw new BadRequestException(
        'Facebook posts support up to 63,206 characters.',
      );
    }
    if (mediaType === 'mixed') {
      throw new BadRequestException(
        'Facebook mixed media publishing is not supported in this MVP. Use images or one video.',
      );
    }
    if (mediaType === 'video' && mediaUrls.length !== 1) {
      throw new BadRequestException(
        'Facebook video posts require exactly one video URL.',
      );
    }
  }

  async publish(context: PublishContext): Promise<PublishResult> {
    this.validateContentLimits(context.post);
    const accessToken = this.getAccessToken(context.channel);
    const pageId = context.channel.account;
    const { post } = context;

    if (post.mediaType === 'video') {
      return this.publishVideo(
        pageId,
        accessToken,
        post.mediaUrls[0],
        post.content,
      );
    }

    if (post.mediaType === 'image' && post.mediaUrls.length > 0) {
      return post.mediaUrls.length === 1
        ? this.publishSinglePhoto(
            pageId,
            accessToken,
            post.mediaUrls[0],
            post.content,
          )
        : this.publishMultiPhoto(
            pageId,
            accessToken,
            post.mediaUrls,
            post.content,
          );
    }

    const response = await axios.post(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${pageId}/feed`,
      null,
      {
        params: {
          message: post.content,
          access_token: accessToken,
        },
      },
    );

    return {
      platformPostId: response.data.id,
      raw: response.data,
    };
  }

  private async publishSinglePhoto(
    pageId: string,
    accessToken: string,
    imageUrl: string,
    caption: string,
  ): Promise<PublishResult> {
    const response = await axios.post(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${pageId}/photos`,
      null,
      {
        params: {
          url: imageUrl,
          caption,
          published: true,
          access_token: accessToken,
        },
      },
    );

    return {
      platformPostId: response.data.post_id ?? response.data.id,
      platformMediaId: response.data.id,
      raw: response.data,
    };
  }

  private async publishMultiPhoto(
    pageId: string,
    accessToken: string,
    mediaUrls: string[],
    message: string,
  ): Promise<PublishResult> {
    const uploaded = await Promise.all(
      mediaUrls.map((url) =>
        axios.post(
          `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${pageId}/photos`,
          null,
          {
            params: {
              url,
              published: false,
              access_token: accessToken,
            },
          },
        ),
      ),
    );

    const attachedMedia = uploaded.map((item) => ({
      media_fbid: item.data.id,
    }));

    const response = await axios.post(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${pageId}/feed`,
      null,
      {
        params: {
          message,
          attached_media: attachedMedia.map((media) => JSON.stringify(media)),
          access_token: accessToken,
        },
      },
    );

    return {
      platformPostId: response.data.id,
      platformMediaId: uploaded.map((item) => item.data.id).join(','),
      raw: {
        post: response.data,
        media: uploaded.map((item) => item.data),
      },
    };
  }

  private async publishVideo(
    pageId: string,
    accessToken: string,
    videoUrl: string,
    description: string,
  ): Promise<PublishResult> {
    if (!/^https?:\/\//i.test(videoUrl)) {
      throw new BadRequestException(
        'Facebook video publishing requires a public video URL.',
      );
    }

    const response = await axios.post(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${pageId}/videos`,
      null,
      {
        params: {
          file_url: videoUrl,
          description,
          access_token: accessToken,
        },
      },
    );

    return {
      platformPostId: response.data.id,
      platformMediaId: response.data.id,
      raw: response.data,
    };
  }
}
