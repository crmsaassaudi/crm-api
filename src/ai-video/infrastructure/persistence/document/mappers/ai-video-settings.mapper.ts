import { AiVideoSettings } from '../../../../domain/ai-video-settings';
import { AiVideoSettingsSchemaClass } from '../entities/ai-video-settings.schema';

export class AiVideoSettingsMapper {
  static toDomain(raw: any): AiVideoSettings {
    const entity = new AiVideoSettings();
    entity.id = raw._id.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.timeSlots = raw.timeSlots ? [...raw.timeSlots] : [];
    entity.retainOriginalDays = raw.retainOriginalDays;
    entity.retainProcessedDays = raw.retainProcessedDays;
    entity.autoCleanupTempFiles = raw.autoCleanupTempFiles;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }
}
