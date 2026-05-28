import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { CrmSettingRepository } from './infrastructure/persistence/document/repositories/crm-setting.repository';
import { CrmSetting } from './domain/crm-setting';
import { ClsService } from 'nestjs-cls';
import { TenantSettingsSeedingService } from './tenant-settings-seeding.service';
import { ulid } from 'ulid';
import { Model } from 'mongoose';
import {
  ContactSchemaClass,
  ContactSchemaDocument,
} from '../contacts/infrastructure/persistence/document/entities/contact.schema';

const LIFECYCLE_STAGE_MUTABLE_FIELDS = new Set([
  'name',
  'apiName',
  'sortOrder',
  'color',
  'description',
  'isConverted',
  'isTerminal',
  'mandatoryFields',
  'triggerDealCreation',
  'statuses',
]);
const LIFECYCLE_STATUS_MUTABLE_FIELDS = new Set([
  'label',
  'apiName',
  'sortOrder',
  'color',
  'isDefault',
  'isTerminal',
  'isWon',
  'probability',
  'daysInStage',
]);

@Injectable()
export class CrmSettingsService {
  private readonly settingsCache = new Map<
    string,
    { value: any; expiresAt: number }
  >();
  private static readonly CACHE_TTL_MS = 30_000; // 30 seconds

  constructor(
    private readonly repository: CrmSettingRepository,
    private readonly cls: ClsService,
    private readonly seeding: TenantSettingsSeedingService,
    @InjectModel(ContactSchemaClass.name)
    private readonly contactModel: Model<ContactSchemaDocument>,
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
    const cacheKey = `${tid}:${key}`;

    // Check in-memory cache first to avoid a MongoDB round-trip on every request.
    // This is critical for hot-path settings like 'layout_settings' which are
    // read by DataMaskingInterceptor on every single HTTP response.
    const cached = this.settingsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const setting = await this.repository.findOne(tid, key);

    if (!setting) {
      // Lazy-seed: existing tenants that predate a new module deployment
      // will receive the default value on their first GET.
      const seeded = await this.seeding.lazySeed(tid, key);
      this.settingsCache.set(cacheKey, {
        value: seeded,
        expiresAt: Date.now() + CrmSettingsService.CACHE_TTL_MS,
      });
      return seeded;
    }

    this.settingsCache.set(cacheKey, {
      value: setting.value,
      expiresAt: Date.now() + CrmSettingsService.CACHE_TTL_MS,
    });
    return setting.value;
  }

  async updateSetting(
    key: string,
    value: any,
    tenantId?: string,
  ): Promise<CrmSetting> {
    const tid = this.resolveTenantId(tenantId);

    // Invalidate cache on write so the next read fetches fresh data.
    this.settingsCache.delete(`${tid}:${key}`);

    return this.repository.update(tid, key, value);
  }

  async createLifecycleStage(
    objectId: string,
    payload: Record<string, any>,
    tenantId?: string,
  ): Promise<any> {
    const tid = this.resolveTenantId(tenantId);
    const key = this.getLifecycleSettingKey(objectId);
    const setting = await this.getLifecycleSettingOrThrow(key, tid);
    const stages = this.getLifecycleStages(setting);
    const apiName = this.normalizeApiName(payload.apiName ?? payload.name);

    if (!payload.name?.trim()) {
      throw new BadRequestException('Lifecycle stage name is required');
    }

    if (!apiName) {
      throw new BadRequestException('Lifecycle stage apiName is required');
    }

    if (stages.some((stage) => stage.apiName === apiName)) {
      throw new ConflictException(
        `Lifecycle stage apiName "${apiName}" already exists`,
      );
    }

    const stage = {
      id: this.generateUlid(),
      name: payload.name.trim(),
      apiName,
      sortOrder:
        typeof payload.sortOrder === 'number'
          ? payload.sortOrder
          : stages.length + 1,
      color: payload.color ?? '#3b82f6',
      description: payload.description,
      isConverted: payload.isConverted ?? false,
      isTerminal: payload.isTerminal ?? false,
      mandatoryFields: payload.mandatoryFields ?? [],
      triggerDealCreation: payload.triggerDealCreation ?? false,
      statuses: payload.statuses ?? [],
    };

    const updated = await this.repository.pushLifecycleStage(tid, key, stage);
    if (!updated) {
      throw new ConflictException('Lifecycle stage was changed concurrently');
    }

    return updated.value;
  }

  async updateLifecycleStage(
    objectId: string,
    stageId: string,
    payload: Record<string, any>,
    tenantId?: string,
  ): Promise<any> {
    const tid = this.resolveTenantId(tenantId);
    const key = this.getLifecycleSettingKey(objectId);
    const setting = await this.getLifecycleSettingOrThrow(key, tid);
    const stages = this.getLifecycleStages(setting);
    const stage = stages.find((item) => item.id === stageId);

    if (!stage) {
      throw new NotFoundException(`Lifecycle stage "${stageId}" not found`);
    }

    const updates: Record<string, any> = {};
    for (const [field, value] of Object.entries(payload)) {
      if (LIFECYCLE_STAGE_MUTABLE_FIELDS.has(field)) {
        updates[field] =
          field === 'apiName' ? this.normalizeApiName(value) : value;
      }
    }

    if (Object.keys(updates).length === 0) {
      return setting;
    }

    if (updates.name !== undefined && !String(updates.name).trim()) {
      throw new BadRequestException('Lifecycle stage name is required');
    }

    if (updates.name !== undefined) {
      updates.name = String(updates.name).trim();
    }

    if (updates.apiName !== undefined) {
      if (!updates.apiName) {
        throw new BadRequestException('Lifecycle stage apiName is required');
      }

      const duplicate = stages.some(
        (item) => item.id !== stageId && item.apiName === updates.apiName,
      );
      if (duplicate) {
        throw new ConflictException(
          `Lifecycle stage apiName "${updates.apiName}" already exists`,
        );
      }

      if (
        objectId.toLowerCase() === 'contact' &&
        updates.apiName !== stage.apiName
      ) {
        await this.assertLifecycleStageIsNotReferenced(tid, stage);
      }
    }

    const updated = await this.repository.updateLifecycleStage(
      tid,
      key,
      stageId,
      updates,
    );
    if (!updated) {
      throw new ConflictException('Lifecycle stage was changed concurrently');
    }

    return updated.value;
  }

  async deleteLifecycleStage(
    objectId: string,
    stageId: string,
    tenantId?: string,
  ): Promise<any> {
    const tid = this.resolveTenantId(tenantId);
    const key = this.getLifecycleSettingKey(objectId);
    const setting = await this.getLifecycleSettingOrThrow(key, tid);
    const stage = this.getLifecycleStages(setting).find(
      (item) => item.id === stageId,
    );

    if (!stage) {
      throw new NotFoundException(`Lifecycle stage "${stageId}" not found`);
    }

    if (objectId.toLowerCase() === 'contact') {
      await this.assertLifecycleStageIsNotReferenced(tid, stage);
    }

    const updated = await this.repository.pullLifecycleStage(tid, key, stageId);
    if (!updated) {
      throw new ConflictException('Lifecycle stage was changed concurrently');
    }

    return updated.value;
  }

  async createLifecycleStatus(
    objectId: string,
    stageId: string,
    payload: Record<string, any>,
    tenantId?: string,
  ): Promise<any> {
    const tid = this.resolveTenantId(tenantId);
    const key = this.getLifecycleSettingKey(objectId);
    const setting = await this.getLifecycleSettingOrThrow(key, tid);
    const stage = this.getLifecycleStageOrThrow(setting, stageId);
    const statuses = this.getLifecycleStatuses(stage);
    const apiName = this.normalizeApiName(payload.apiName ?? payload.label);

    if (!payload.label?.trim()) {
      throw new BadRequestException('Lifecycle status label is required');
    }

    if (!apiName) {
      throw new BadRequestException('Lifecycle status apiName is required');
    }

    if (statuses.some((status) => status.apiName === apiName)) {
      throw new ConflictException(
        `Lifecycle status apiName "${apiName}" already exists`,
      );
    }

    const status = {
      id: this.generateUlid(),
      label: payload.label.trim(),
      apiName,
      sortOrder:
        typeof payload.sortOrder === 'number'
          ? payload.sortOrder
          : statuses.length + 1,
      color: payload.color ?? stage.color ?? '#3b82f6',
      isDefault: payload.isDefault ?? false,
      isTerminal: payload.isTerminal ?? false,
      isWon: payload.isWon,
      probability: payload.probability,
      daysInStage: payload.daysInStage,
    };

    if (status.isDefault) {
      await this.repository.clearLifecycleStatusDefaults(tid, key, stageId);
    }

    const updated = await this.repository.pushLifecycleStatus(
      tid,
      key,
      stageId,
      status,
    );
    if (!updated) {
      throw new ConflictException('Lifecycle status was changed concurrently');
    }

    return updated.value;
  }

  async updateLifecycleStatus(
    objectId: string,
    stageId: string,
    statusId: string,
    payload: Record<string, any>,
    tenantId?: string,
  ): Promise<any> {
    const tid = this.resolveTenantId(tenantId);
    const key = this.getLifecycleSettingKey(objectId);
    const setting = await this.getLifecycleSettingOrThrow(key, tid);
    const stage = this.getLifecycleStageOrThrow(setting, stageId);
    const statuses = this.getLifecycleStatuses(stage);
    const status = statuses.find((item) => item.id === statusId);

    if (!status) {
      throw new NotFoundException(`Lifecycle status "${statusId}" not found`);
    }

    const updates: Record<string, any> = {};
    for (const [field, value] of Object.entries(payload)) {
      if (LIFECYCLE_STATUS_MUTABLE_FIELDS.has(field)) {
        updates[field] =
          field === 'apiName' ? this.normalizeApiName(value) : value;
      }
    }

    if (Object.keys(updates).length === 0) {
      return setting;
    }

    if (updates.label !== undefined && !String(updates.label).trim()) {
      throw new BadRequestException('Lifecycle status label is required');
    }

    if (updates.label !== undefined) {
      updates.label = String(updates.label).trim();
    }

    if (updates.apiName !== undefined) {
      if (!updates.apiName) {
        throw new BadRequestException('Lifecycle status apiName is required');
      }

      const duplicate = statuses.some(
        (item) => item.id !== statusId && item.apiName === updates.apiName,
      );
      if (duplicate) {
        throw new ConflictException(
          `Lifecycle status apiName "${updates.apiName}" already exists`,
        );
      }

      if (
        objectId.toLowerCase() === 'contact' &&
        updates.apiName !== status.apiName
      ) {
        await this.assertLifecycleStatusIsNotReferenced(tid, status);
      }
    }

    if (updates.isDefault === true) {
      await this.repository.clearLifecycleStatusDefaults(tid, key, stageId);
    }

    const updated = await this.repository.updateLifecycleStatus(
      tid,
      key,
      stageId,
      statusId,
      updates,
    );
    if (!updated) {
      throw new ConflictException('Lifecycle status was changed concurrently');
    }

    return updated.value;
  }

  async deleteLifecycleStatus(
    objectId: string,
    stageId: string,
    statusId: string,
    tenantId?: string,
  ): Promise<any> {
    const tid = this.resolveTenantId(tenantId);
    const key = this.getLifecycleSettingKey(objectId);
    const setting = await this.getLifecycleSettingOrThrow(key, tid);
    const stage = this.getLifecycleStageOrThrow(setting, stageId);
    const status = this.getLifecycleStatuses(stage).find(
      (item) => item.id === statusId,
    );

    if (!status) {
      throw new NotFoundException(`Lifecycle status "${statusId}" not found`);
    }

    if (objectId.toLowerCase() === 'contact') {
      await this.assertLifecycleStatusIsNotReferenced(tid, status);
    }

    const updated = await this.repository.pullLifecycleStatus(
      tid,
      key,
      stageId,
      statusId,
    );
    if (!updated) {
      throw new ConflictException('Lifecycle status was changed concurrently');
    }

    return updated.value;
  }

  private getLifecycleSettingKey(objectId: string): string {
    const normalizedObject = objectId?.trim().toLowerCase();
    if (!normalizedObject) {
      throw new BadRequestException('objectId is required');
    }
    return `${normalizedObject}_lifecycle`;
  }

  private async getLifecycleSettingOrThrow(
    key: string,
    tenantId: string,
  ): Promise<any> {
    const setting = await this.getSetting(key, tenantId);
    if (!setting || !Array.isArray(setting.stages)) {
      throw new NotFoundException(`Lifecycle setting "${key}" not found`);
    }
    return setting;
  }

  private getLifecycleStages(setting: any): Array<Record<string, any>> {
    return Array.isArray(setting?.stages) ? setting.stages : [];
  }

  private getLifecycleStageOrThrow(
    setting: any,
    stageId: string,
  ): Record<string, any> {
    const stage = this.getLifecycleStages(setting).find(
      (item) => item.id === stageId,
    );

    if (!stage) {
      throw new NotFoundException(`Lifecycle stage "${stageId}" not found`);
    }

    return stage;
  }

  private getLifecycleStatuses(stage: any): Array<Record<string, any>> {
    return Array.isArray(stage?.statuses) ? stage.statuses : [];
  }

  private normalizeApiName(value: unknown): string {
    return String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  private generateUlid(): string {
    return ulid();
  }

  private async assertLifecycleStageIsNotReferenced(
    tenantId: string,
    stage: Record<string, any>,
  ): Promise<void> {
    const referencedIds = [stage.id, stage.apiName].filter(Boolean);
    const contactsCount = await this.contactModel
      .countDocuments({
        tenantId,
        deletedAt: { $exists: false },
        lifecycleStageId: { $in: referencedIds },
      })
      .exec();

    if (contactsCount > 0) {
      throw new ConflictException(
        `Cannot change or delete lifecycle stage "${stage.name}" because ${contactsCount} contact(s) still reference it. Move or merge those contacts first.`,
      );
    }
  }

  private async assertLifecycleStatusIsNotReferenced(
    tenantId: string,
    status: Record<string, any>,
  ): Promise<void> {
    const referencedIds = [status.id, status.apiName].filter(Boolean);
    const contactsCount = await this.contactModel
      .countDocuments({
        tenantId,
        deletedAt: { $exists: false },
        statusId: { $in: referencedIds },
      })
      .exec();

    if (contactsCount > 0) {
      throw new ConflictException(
        `Cannot change or delete lifecycle status "${status.label}" because ${contactsCount} contact(s) still reference it. Move or merge those contacts first.`,
      );
    }
  }
}
