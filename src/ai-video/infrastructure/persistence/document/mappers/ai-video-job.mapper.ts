import { AiVideoJob } from '../../../../domain/ai-video-job';

/**
 * Maps Mongoose documents to plain domain objects.
 *
 * CRITICAL: Never assign raw Mongoose subdocument arrays directly —
 * always spread or .map() to a new plain array to avoid
 * "Maximum call stack size exceeded" in the serialization interceptor chain.
 *
 * We accept `any` for the raw parameter because Mongoose HydratedDocument
 * types add internal properties (_id, createdAt, updatedAt) that are not
 * declared on the SchemaClass but are always present on documents.
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
    entity.facebookPageId = raw.facebookPageId;
    entity.caption = raw.caption;
    // Spread to a new plain array — never assign Mongoose DocumentArray directly
    entity.hashtags = raw.hashtags ? [...raw.hashtags] : [];
    entity.scheduledAt = raw.scheduledAt;
    entity.publishedAt = raw.publishedAt;
    entity.platformVideoId = raw.platformVideoId;
    entity.platformPostId = raw.platformPostId;
    entity.errorDetails = raw.errorDetails;
    entity.rejectReason = raw.rejectReason;
    entity.createdById = raw.createdById?.toString();
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }
}
