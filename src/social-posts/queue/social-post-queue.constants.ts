export const SOCIAL_POST_PUBLISH_QUEUE = 'social-post-publish';

export const socialPostPublishJobId = (postId: string, batchId: string) =>
  `social-post:${postId}:${batchId}`;
