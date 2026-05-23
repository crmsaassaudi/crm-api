export const PUBLICATION_INSTANCE_PUBLISH_QUEUE =
  'publication-instance-publish';

export const publicationInstancePublishJobId = (
  publicationInstanceId: string,
) => `publication-instance-${publicationInstanceId}`;
