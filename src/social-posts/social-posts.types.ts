export const SOCIAL_POST_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'PUBLISHING',
  'COMPLETED',
  'PARTIALLY_FAILED',
  'FAILED',
] as const;

export const SOCIAL_POST_APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
] as const;

export const SOCIAL_POST_TASK_STATUSES = [
  'PENDING',
  'PUBLISHING',
  'SUCCESS',
  'FAILED',
] as const;

export const SOCIAL_POST_PLATFORMS = [
  'facebook',
  'instagram',
  'tiktok',
] as const;

export const SOCIAL_POST_MEDIA_TYPES = [
  'text',
  'image',
  'video',
  'mixed',
] as const;

export type SocialPostStatus = (typeof SOCIAL_POST_STATUSES)[number];
export type SocialPostApprovalStatus =
  (typeof SOCIAL_POST_APPROVAL_STATUSES)[number];
export type SocialPostTaskStatus = (typeof SOCIAL_POST_TASK_STATUSES)[number];
export type SocialPostPlatform = (typeof SOCIAL_POST_PLATFORMS)[number];
export type SocialPostMediaType = (typeof SOCIAL_POST_MEDIA_TYPES)[number];

export interface SocialPostPublishJobData {
  tenantId: string;
  postId: string;
}
