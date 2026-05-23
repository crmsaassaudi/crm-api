import { AiVideoJob } from '../../../../domain/ai-video-job';

/**
 * Maps Mongoose documents to plain domain objects.
 *
 * Always clone array fields before returning them so serialization does not
 * receive Mongoose document arrays.
 */
export class AiVideoJobMapper {
  static toDomain(raw: any): AiVideoJob {
    const entity = new AiVideoJob();
    entity.id = raw._id.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.sourceType = raw.sourceType;
    entity.sourceUrl = raw.sourceUrl;
    entity.scriptText = raw.scriptText;
    entity.status = raw.status as AiVideoJob['status'];
    entity.recipeId = raw.recipeId?.toString();
    entity.caption = raw.caption;
    entity.hashtags = raw.hashtags ? [...raw.hashtags] : [];
    entity.errorDetails = raw.errorDetails;
    entity.rejectReason = raw.rejectReason;
    entity.createdById = raw.createdById?.toString();
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }
}
