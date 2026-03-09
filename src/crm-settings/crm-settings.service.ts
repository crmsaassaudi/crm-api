import { Injectable } from '@nestjs/common';
import { CrmSettingRepository } from './infrastructure/persistence/document/repositories/crm-setting.repository';
import { CrmSetting } from './domain/crm-setting';
import { ClsService } from 'nestjs-cls';
import { TenantSettingsSeedingService } from './tenant-settings-seeding.service';

@Injectable()
export class CrmSettingsService {
  constructor(
    private readonly repository: CrmSettingRepository,
    private readonly cls: ClsService,
    private readonly seeding: TenantSettingsSeedingService,
  ) {}

  async getSetting(key: string): Promise<any> {
    const tenant = this.cls.get('tenantId');
    const setting = await this.repository.findOne(tenant, key);
    if (setting) return setting.value;

    // Lazy-seed: existing tenants that predate a new module deployment
    // will receive the default value on their first GET.
    return this.seeding.lazySeed(tenant, key);
  }

  async updateSetting(key: string, value: any): Promise<CrmSetting> {
    const tenant = this.cls.get('tenantId');
    return this.repository.update(tenant, key, value);
  }
}
