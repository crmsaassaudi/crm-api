import { AiVideoSettings } from '../../../../domain/ai-video-settings';

export class AiVideoSettingsMapper {
  static toDomain(raw: any): AiVideoSettings {
    const entity = new AiVideoSettings();
    entity.id = raw._id.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.retainOriginalDays = raw.retainOriginalDays;
    entity.retainProcessedDays = raw.retainProcessedDays;
    entity.autoCleanupTempFiles = raw.autoCleanupTempFiles;
    entity.elevenLabsApiKey = raw.elevenLabsApiKey;
    entity.defaultVoiceId = raw.defaultVoiceId;
    entity.bgmVolume = raw.bgmVolume;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    return entity;
  }
}
