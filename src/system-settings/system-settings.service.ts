import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SystemSettingsSchemaClass } from './entities/system-settings.schema';

export type MaintenanceModeSnapshot = {
  enabled: boolean;
  enabledAt: Date | null;
  enabledBy: string | null;
  whitelistedIPs: string[];
};

@Injectable()
export class SystemSettingsService {
  private maintenanceModeCache:
    | { expiresAt: number; value: MaintenanceModeSnapshot }
    | undefined;

  constructor(
    @InjectModel(SystemSettingsSchemaClass.name)
    private readonly settingsModel: Model<SystemSettingsSchemaClass>,
  ) {}

  async getMaintenanceModeSnapshot(
    forceRefresh = false,
  ): Promise<MaintenanceModeSnapshot> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.maintenanceModeCache &&
      this.maintenanceModeCache.expiresAt > now
    ) {
      return this.maintenanceModeCache.value;
    }

    const doc = (await this.settingsModel
      .findOne({ key: 'global' })
      .select('maintenanceMode')
      .lean()
      .exec()) as { maintenanceMode?: Partial<MaintenanceModeSnapshot> } | null;

    const value: MaintenanceModeSnapshot = {
      enabled: doc?.maintenanceMode?.enabled ?? false,
      enabledAt: doc?.maintenanceMode?.enabledAt ?? null,
      enabledBy: doc?.maintenanceMode?.enabledBy ?? null,
      whitelistedIPs: this.normalizeWhitelistedIPs(
        doc?.maintenanceMode?.whitelistedIPs,
      ),
    };

    this.maintenanceModeCache = {
      expiresAt: now + this.getMaintenanceCacheTtlMs(),
      value,
    };

    return value;
  }

  private normalizeWhitelistedIPs(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return Array.from(
      new Set(
        value
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    );
  }

  private getMaintenanceCacheTtlMs(): number {
    const ttl = Number(process.env.SYSTEM_SETTINGS_CACHE_TTL_MS ?? 5000);
    return Number.isFinite(ttl) && ttl >= 0 ? ttl : 5000;
  }
}
