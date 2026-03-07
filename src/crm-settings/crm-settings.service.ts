import { Injectable } from '@nestjs/common';
import { CrmSettingRepository } from './infrastructure/persistence/document/repositories/crm-setting.repository';
import { CrmSetting } from './domain/crm-setting';
import { ClsService } from 'nestjs-cls';

@Injectable()
export class CrmSettingsService {
    constructor(
        private readonly repository: CrmSettingRepository,
        private readonly cls: ClsService,
    ) { }

    async getSetting(key: string): Promise<any> {
        const tenant = this.cls.get('tenantId');
        const setting = await this.repository.findOne(tenant, key);
        return setting?.value ?? null;
    }

    async updateSetting(key: string, value: any): Promise<CrmSetting> {
        const tenant = this.cls.get('tenantId');
        return this.repository.update(tenant, key, value);
    }
}
