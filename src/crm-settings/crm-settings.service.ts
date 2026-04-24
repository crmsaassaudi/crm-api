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

  /**
   * Resolve the effective tenantId.
   * If explicitly provided → use it (cron jobs, event handlers, webhooks).
   * Otherwise → fallback to CLS request context (HTTP controllers).
   */
  private resolveTenantId(tenantId?: string): string {
    return tenantId ?? this.cls.get('tenantId');
  }

  async getSetting(key: string, tenantId?: string): Promise<any> {
    const tid = this.resolveTenantId(tenantId);
    const setting = await this.repository.findOne(tid, key);

    if (!setting) {
      // Lazy-seed: existing tenants that predate a new module deployment
      // will receive the default value on their first GET.
      return this.seeding.lazySeed(tid, key);
    }

    // ── layout_settings: transparent migration for existing tenants ──
    // If the stored value exists but has no sectionConfigs, inject the system
    // defaults and persist them so subsequent reads are consistent.
    if (
      key === 'layout_settings' &&
      setting.value &&
      !setting.value['sectionConfigs']
    ) {
      const defaults = this.seeding.getDefault(key) as any;
      if (defaults?.sectionConfigs) {
        const migrated = {
          ...setting.value,
          sectionConfigs: defaults.sectionConfigs,
        };
        await this.repository.update(tid, key, migrated);
        return migrated;
      }
    }

    // ── list_views: transparent migration for existing tenants ──
    // Merge new system-default views from seed into existing tenant data.
    // This ensures existing tenants receive new system views (e.g. "All Contacts",
    // "My Open Leads") without needing a manual migration script.
    if (key === 'list_views' && setting.value?.views) {
      const defaults = this.seeding.getDefault(key) as any;
      const defaultViews: any[] = defaults?.views || [];
      const existingViews: any[] = setting.value.views;
      const existingIds = new Set(existingViews.map((v: any) => v.id));

      const missingSystemViews = defaultViews.filter(
        (v: any) => v.isSystemDefault && !existingIds.has(v.id),
      );

      if (missingSystemViews.length > 0) {
        // Prepend missing system views before custom ones
        const migrated = {
          ...setting.value,
          views: [...missingSystemViews, ...existingViews],
        };
        await this.repository.update(tid, key, migrated);
        return migrated;
      }
    }

    return setting.value;

  }

  async updateSetting(
    key: string,
    value: any,
    tenantId?: string,
  ): Promise<CrmSetting> {
    const tid = this.resolveTenantId(tenantId);
    return this.repository.update(tid, key, value);
  }
}
