export const SOCIAL_CONTENT_ASSET_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;

export const SOCIAL_CONTENT_APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
] as const;

export const PUBLICATION_INSTANCE_STATUSES = [
  'PENDING',
  'PUBLISHING',
  'SUCCESS',
  'FAILED',
  'CANCELED',
] as const;

export const SOCIAL_CONTENT_PLATFORMS = [
  'facebook',
  'instagram',
  'tiktok',
] as const;

export const SOCIAL_CONTENT_MEDIA_TYPES = [
  'text',
  'image',
  'video',
  'mixed',
] as const;

export type SocialContentAssetStatus =
  (typeof SOCIAL_CONTENT_ASSET_STATUSES)[number];
export type SocialContentApprovalStatus =
  (typeof SOCIAL_CONTENT_APPROVAL_STATUSES)[number];
export type PublicationInstanceStatus =
  (typeof PUBLICATION_INSTANCE_STATUSES)[number];
export type SocialContentPlatform = (typeof SOCIAL_CONTENT_PLATFORMS)[number];
export type SocialContentMediaType =
  (typeof SOCIAL_CONTENT_MEDIA_TYPES)[number];

export interface PublicationSnapshot {
  content: string;
  mediaUrls: string[];
  aiVideoJobIds?: string[];
  mediaType: SocialContentMediaType;
}

export interface PublicationPublishJobData {
  tenantId: string;
  publicationInstanceId: string;
}
