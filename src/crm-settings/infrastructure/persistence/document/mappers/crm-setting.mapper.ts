import { CrmSetting } from '../../../../domain/crm-setting';
import { CrmSettingSchemaClass } from '../entities/crm-setting.schema';

export class CrmSettingMapper {
  static toDomain(raw: CrmSettingSchemaClass): CrmSetting {
    const domainEntity = new CrmSetting();
    domainEntity.tenant = raw.tenant;
    domainEntity.key = raw.key;
    domainEntity.value = raw.value;
    domainEntity.createdAt = raw.createdAt;
    domainEntity.updatedAt = raw.updatedAt;
    return domainEntity;
  }

  static toPersistence(domainEntity: CrmSetting): CrmSettingSchemaClass {
    const persistenceEntity = new CrmSettingSchemaClass();
    persistenceEntity.tenant = domainEntity.tenant;
    persistenceEntity.key = domainEntity.key;
    persistenceEntity.value = domainEntity.value;
    return persistenceEntity;
  }
}
