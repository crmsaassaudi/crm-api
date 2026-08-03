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
import {
  DATA_SCOPE_ORDER,
  isDataScope,
} from '../common/permissions/data-scope.enum';
import {
  VISIBILITY_MODULES,
  isVisibilityModule,
} from '../common/permissions/visibility-modules';

const LIFECYCLE_STAGE_MUTABLE_FIELDS = new Set([
  'name',
  'apiName',
  'sortOrder',
  'color',
  'description',

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

    validateVisibilitySetting(key, value);
    validateNavigationSetting(key, value);

    // Invalidate cache on write so the next read fetches fresh data.
    this.settingsCache.delete(`${tid}:${key}`);

    return this.repository.update(tid, key, value);
  }

  // List Views (atomic array ops, cache-invalidating)
  // These delegate to the repository's atomic $push/$set/$pull operators so
  // ListViewsService never has to read-modify-write the whole views array.

  async pushListView(
    key: string,
    view: Record<string, any>,
    tenantId?: string,
  ): Promise<CrmSetting | null> {
    const tid = this.resolveTenantId(tenantId);
    this.settingsCache.delete(`${tid}:${key}`);
    return this.repository.pushListView(tid, key, view);
  }

  async updateListView(
    key: string,
    viewId: string,
    updates: Record<string, any>,
    tenantId?: string,
  ): Promise<CrmSetting | null> {
    const tid = this.resolveTenantId(tenantId);
    this.settingsCache.delete(`${tid}:${key}`);
    return this.repository.updateListView(tid, key, viewId, updates);
  }

  async pullListView(
    key: string,
    viewId: string,
    tenantId?: string,
  ): Promise<CrmSetting | null> {
    const tid = this.resolveTenantId(tenantId);
    this.settingsCache.delete(`${tid}:${key}`);
    return this.repository.pullListView(tid, key, viewId);
  }

  async pushManyListViews(
    key: string,
    views: Record<string, any>[],
    tenantId?: string,
  ): Promise<CrmSetting | null> {
    const tid = this.resolveTenantId(tenantId);
    this.settingsCache.delete(`${tid}:${key}`);
    return this.repository.pushManyListViews(tid, key, views);
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

    const updates = this.filterMutableFields(
      payload,
      LIFECYCLE_STAGE_MUTABLE_FIELDS,
    );
    if (Object.keys(updates).length === 0) {
      return setting;
    }

    this.validateNameField(updates, 'Lifecycle stage name');

    if (updates.apiName !== undefined) {
      this.validateApiNameUniqueness(updates.apiName, stageId, stages);

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

    const updates = this.filterMutableFields(
      payload,
      LIFECYCLE_STATUS_MUTABLE_FIELDS,
    );

    if (Object.keys(updates).length === 0) {
      return setting;
    }

    this.validateNameField(updates, 'Lifecycle status label', 'label');

    if (updates.apiName !== undefined) {
      this.validateApiNameUniqueness(updates.apiName, statusId, statuses);

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
      .replace(/(?:^_+)|(?:_+$)/g, '');
  }

  /** Filter payload fields against a set of mutable field names, normalizing apiName. */
  private filterMutableFields(
    payload: Record<string, any>,
    mutableFields: Set<string>,
  ): Record<string, any> {
    const updates: Record<string, any> = {};
    for (const [field, value] of Object.entries(payload)) {
      if (mutableFields.has(field)) {
        updates[field] =
          field === 'apiName' ? this.normalizeApiName(value) : value;
      }
    }
    return updates;
  }

  /** Validate that a name/label field is non-empty and trim it. */
  private validateNameField(
    updates: Record<string, any>,
    label: string,
    fieldName = 'name',
  ): void {
    if (updates[fieldName] === undefined) return;
    if (!String(updates[fieldName]).trim()) {
      throw new BadRequestException(`${label} is required`);
    }
    updates[fieldName] = String(updates[fieldName]).trim();
  }

  /** Validate that an apiName is non-empty and unique within a collection. */
  private validateApiNameUniqueness(
    apiName: string,
    excludeId: string,
    items: Array<Record<string, any>>,
  ): void {
    if (!apiName) {
      throw new BadRequestException('Lifecycle apiName is required');
    }
    const duplicate = items.some(
      (item) => item.id !== excludeId && item.apiName === apiName,
    );
    if (duplicate) {
      throw new ConflictException(
        `Lifecycle apiName "${apiName}" already exists`,
      );
    }
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

/**
 * Reject a navigation config the sidebar could not render.
 *
 * Two failure modes worth catching here rather than in the browser: a
 * workspace list that nobody can see (every entry hidden or gated) leaves the
 * switcher empty and the user on a blank menu, and an item pointing at a
 * workspace id that does not exist simply vanishes with no error anywhere.
 *
 * Item ids are NOT validated against a catalog: the catalog lives in the web
 * app, ships on its own cadence, and an id this API has not heard of is a
 * front-end item from a newer build, not a mistake.
 */
function validateNavigationSetting(key: string, value: any): void {
  if (key !== 'navigation_workspaces') return;

  const workspaces = value?.workspaces;
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw new BadRequestException(
      'navigation_workspaces.workspaces must be a non-empty array',
    );
  }

  const ids = new Set<string>();
  for (const workspace of workspaces) {
    const id = workspace?.id;
    if (typeof id !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(id)) {
      throw new BadRequestException(
        `Workspace id must be a slug of letters, digits, dash or underscore (got "${id}")`,
      );
    }
    if (ids.has(id)) {
      throw new BadRequestException(`Duplicate workspace id "${id}"`);
    }
    ids.add(id);

    if (typeof workspace?.label !== 'string' || !workspace.label.trim()) {
      throw new BadRequestException(`Workspace "${id}" needs a label`);
    }

    const requires = workspace?.requires;
    if (
      requires !== null &&
      requires !== undefined &&
      requires !== 'owner' &&
      !(typeof requires === 'string' && requires.startsWith('permission:'))
    ) {
      throw new BadRequestException(
        `Workspace "${id}": requires must be null, "owner", or "permission:<key>"`,
      );
    }
  }

  // An ungated, visible workspace has to survive, or a tenant can lock its own
  // members out of the menu with a settings write.
  const reachable = workspaces.some(
    (workspace: any) =>
      !workspace?.hidden &&
      (workspace?.requires === null || workspace?.requires === undefined),
  );
  if (!reachable) {
    throw new BadRequestException(
      'At least one workspace must be visible with no access requirement, ' +
        'otherwise members with no admin permissions see an empty menu.',
    );
  }

  const items = value?.items;
  if (items !== undefined && items !== null) {
    if (!Array.isArray(items)) {
      throw new BadRequestException(
        'navigation_workspaces.items must be an array',
      );
    }
    for (const item of items) {
      if (typeof item?.itemId !== 'string' || !item.itemId) {
        throw new BadRequestException('Every navigation item needs an itemId');
      }
      if (!Array.isArray(item?.workspaces)) {
        throw new BadRequestException(
          `Item "${item.itemId}": workspaces must be an array`,
        );
      }
      for (const workspaceId of item.workspaces) {
        if (!ids.has(workspaceId)) {
          throw new BadRequestException(
            `Item "${item.itemId}" references unknown workspace "${workspaceId}"`,
          );
        }
      }
    }
  }
}

/**
 * Reject data-visibility settings that the enforcement layer would silently
 * ignore.
 *
 * The read path is deliberately forgiving — an unknown scope string falls back
 * to the tenant default, an unknown module key is simply never consulted — so
 * without this an admin could save "Deals: whole department", see it persisted,
 * and never find out it does nothing. Every value offered by the settings UI
 * has to be a value the interceptor actually understands, and the only place
 * both sides meet is here.
 */
function validateVisibilitySetting(key: string, value: any): void {
  if (key === 'data_visibility') {
    assertAccess(value?.defaultAccess, 'defaultAccess');
    assertScope(value?.defaultScope, 'defaultScope');

    const byModule = value?.byModule;
    if (byModule !== undefined && byModule !== null) {
      if (typeof byModule !== 'object' || Array.isArray(byModule)) {
        throw new BadRequestException('byModule must be an object');
      }
      for (const [moduleKey, override] of Object.entries<any>(byModule)) {
        if (!isVisibilityModule(moduleKey)) {
          throw new BadRequestException(
            `Unknown module "${moduleKey}". Allowed: ${VISIBILITY_MODULES.join(', ')}`,
          );
        }
        assertAccess(override?.access, `byModule.${moduleKey}.access`);
        assertScope(override?.scope, `byModule.${moduleKey}.scope`);
      }
    }
    return;
  }

  if (key === 'sharing_rules') {
    const rules = value?.rules;
    if (rules === undefined || rules === null) return;
    if (!Array.isArray(rules)) {
      throw new BadRequestException('sharing_rules.rules must be an array');
    }
    for (const rule of rules) {
      const source = rule?.sharedFrom?.type;
      if (!['user', 'group', 'org_unit', 'all'].includes(source)) {
        throw new BadRequestException(
          `sharedFrom.type must be one of user, group, org_unit, all (got "${source}")`,
        );
      }
      const target = rule?.shareWith?.type;
      if (!['user', 'group', 'role'].includes(target)) {
        throw new BadRequestException(
          `shareWith.type must be one of user, group, role (got "${target}")`,
        );
      }
      // A rule with no recipients is inert; storing it just makes the sharing
      // list lie about what is in effect.
      if (!Array.isArray(rule?.shareWith?.ids) || !rule.shareWith.ids.length) {
        throw new BadRequestException(
          `Sharing rule "${rule?.name ?? rule?.id}" has no recipients`,
        );
      }
      if (source !== 'all' && !rule?.sharedFrom?.ids?.length) {
        throw new BadRequestException(
          `Sharing rule "${rule?.name ?? rule?.id}" has no source`,
        );
      }
      if (
        rule?.module &&
        rule.module !== '*' &&
        !isVisibilityModule(rule.module)
      ) {
        throw new BadRequestException(`Unknown module "${rule.module}"`);
      }
      if (rule?.expiresAt && Number.isNaN(Date.parse(String(rule.expiresAt)))) {
        throw new BadRequestException('expiresAt must be an ISO timestamp');
      }
    }
  }
}

function assertAccess(value: unknown, field: string): void {
  if (value === undefined || value === null) return;
  if (value !== 'private' && value !== 'public_read') {
    throw new BadRequestException(
      `${field} must be "private" or "public_read"`,
    );
  }
}

function assertScope(value: unknown, field: string): void {
  if (value === undefined || value === null) return;
  if (!isDataScope(value)) {
    throw new BadRequestException(
      `${field} must be one of ${DATA_SCOPE_ORDER.join(', ')}`,
    );
  }
}
