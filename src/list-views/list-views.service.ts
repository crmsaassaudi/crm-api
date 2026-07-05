import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CrmSettingsService } from '../crm-settings/crm-settings.service';
import { GroupsService } from '../groups/groups.service';
import { ClsService } from 'nestjs-cls';
import { UsersService } from '../users/users.service';
import { DEFAULTS_MAP } from '../crm-settings/tenant-settings-seeding.service';
import { ulid } from 'ulid';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ListViewColumn {
  key: string;
  label?: string;
  width?: number;
  isVisible: boolean;
  sortOrder: number;
}

export interface ListViewDefinition {
  id: string;
  name: string;
  module: string;
  createdBy: string;
  isSystemDefault: boolean;
  columns: ListViewColumn[];
  assignedGroupIds: string[];
  /** Users explicitly excluded from this view (even if their group is assigned) */
  excludedUserIds: string[];
}

export interface ListViewsSettings {
  views: ListViewDefinition[];
}

// ── Service ──────────────────────────────────────────────────────────────────

/**
 * ListViewsService — Manages group-level column/field visibility.
 *
 * Business rules:
 * 1. Admin/Owner in Object Manager: sees ALL views, can CRUD.
 * 2. Agent (USER role) on list/detail page: sees ONLY views assigned to their groups.
 *    - If no group-assigned view exists → system default as fallback.
 *    - Multi-group agents can switch between their group views.
 * 3. System default views are created by admin as fallback — not visible to agents
 *    unless no group view is assigned.
 * 4. Per-user override within a group is NOT supported.
 *    To give different views to sub-teams, create sub-groups.
 */
@Injectable()
export class ListViewsService {
  private readonly SETTINGS_KEY = 'list_views';
  private readonly logger = new Logger(ListViewsService.name);

  constructor(
    private readonly settingsService: CrmSettingsService,
    private readonly groupsService: GroupsService,
    private readonly usersService: UsersService,
    private readonly cls: ClsService,
  ) {}

  // ── Read (Agent-scoped — for list/detail pages) ─────────────────────────

  /**
   * Get views for the current user based on their group memberships.
   *
   * For OWNER/ADMIN: returns all views for the module.
   * For regular USER (agent): returns ONLY views assigned to their groups.
   *   If no group view is found, returns the system default as fallback.
   */
  async getViewsForUser(module: string): Promise<ListViewDefinition[]> {
    const settings = await this.getSettings();
    const moduleViews = settings.views.filter(
      (v) => v.module.toLowerCase() === module.toLowerCase(),
    );

    const userId = this.cls.get('userId');
    if (!userId) {
      // Unauthenticated → system default only
      return moduleViews.filter((v) => v.isSystemDefault);
    }

    // Check if user is OWNER or ADMIN in this tenant
    const isAdmin = await this.isAdminOrOwner(userId);
    if (isAdmin) {
      return moduleViews; // Admin sees everything
    }

    // Agent: resolve their groups
    const userGroupIds = await this.getUserGroupIds(userId);

    // System views are always visible to all agents — they define the column layout
    // foundation and should never be hidden even when custom views exist.
    const systemViews = moduleViews.filter((v) => v.isSystemDefault);

    // Custom views: only visible to members of their assigned groups.
    // A view with no assignedGroupIds is not surfaced to any specific group.
    const groupCustomViews = moduleViews.filter(
      (v) =>
        !v.isSystemDefault &&
        v.assignedGroupIds.length > 0 &&
        v.assignedGroupIds.some((gId) => userGroupIds.includes(gId)) &&
        !(v.excludedUserIds || []).includes(userId),
    );

    return [...systemViews, ...groupCustomViews];
  }

  /**
   * Resolve the default view for the current user.
   * Priority: first group-assigned view → system default.
   */
  async getDefaultViewForUser(
    module: string,
  ): Promise<ListViewDefinition | null> {
    const views = await this.getViewsForUser(module);

    // Prefer non-system views first (group-assigned)
    const groupView = views.find((v) => !v.isSystemDefault);
    if (groupView) return groupView;

    // Fallback to system default
    return views.find((v) => v.isSystemDefault) || views[0] || null;
  }

  /**
   * Build a merged view from all views available to the current user.
   * Union of all columns — visible if ANY view has it visible, min sortOrder.
   */
  async getMergedViewForUser(
    module: string,
  ): Promise<ListViewDefinition | null> {
    const views = await this.getViewsForUser(module);
    if (views.length <= 1) return null; // No merge needed for 0 or 1 views

    // Collect all columns across all views
    const columnMap = new Map<
      string,
      { key: string; label?: string; isVisible: boolean; sortOrder: number }
    >();

    for (const view of views) {
      for (const col of view.columns) {
        const existing = columnMap.get(col.key);
        if (existing) {
          // Union: visible if ANY view has it visible
          existing.isVisible = existing.isVisible || col.isVisible;
          // Use min sortOrder (higher priority position)
          existing.sortOrder = Math.min(existing.sortOrder, col.sortOrder);
          // Keep label from the first view that has one
          if (!existing.label && col.label) existing.label = col.label;
        } else {
          columnMap.set(col.key, {
            key: col.key,
            label: col.label,
            isVisible: col.isVisible,
            sortOrder: col.sortOrder,
          });
        }
      }
    }

    // Sort by sortOrder
    const mergedColumns = Array.from(columnMap.values()).sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );

    // Re-assign sequential sortOrder
    mergedColumns.forEach((c, i) => (c.sortOrder = i + 1));

    return {
      id: '__merged__',
      name: 'Merged View',
      module,
      createdBy: 'system',
      isSystemDefault: false,
      columns: mergedColumns,
      assignedGroupIds: [],
      excludedUserIds: [],
    };
  }

  // ── Read (Admin — for Object Manager) ───────────────────────────────────

  /**
   * Get all views for a module (admin endpoint, no filtering).
   */
  async getAllViews(module?: string): Promise<ListViewDefinition[]> {
    const settings = await this.getSettings();
    if (module) {
      return settings.views.filter(
        (v) => v.module.toLowerCase() === module.toLowerCase(),
      );
    }
    return settings.views;
  }

  /**
   * Get a single view by ID.
   */
  async getViewById(id: string): Promise<ListViewDefinition> {
    const settings = await this.getSettings();
    const view = settings.views.find((v) => v.id === id);
    if (!view) throw new NotFoundException(`List view "${id}" not found`);
    return view;
  }

  // ── Write (Admin only) ──────────────────────────────────────────────────

  async createView(
    data: Pick<ListViewDefinition, 'name' | 'module'> &
      Partial<
        Pick<
          ListViewDefinition,
          'columns' | 'assignedGroupIds' | 'excludedUserIds'
        >
      >,
  ): Promise<ListViewDefinition> {
    // Run migration on the write path so a freshly-shipped module's defaults
    // exist before we append a custom view (and so reads never write).
    await this.migrateMissingDefaults();

    const userId = this.cls.get('userId') || 'system';

    const newView: ListViewDefinition = {
      id: this.generateId(),
      name: data.name,
      module: data.module,
      createdBy: userId,
      isSystemDefault: false,
      columns: data.columns ?? [],
      assignedGroupIds: data.assignedGroupIds ?? [],
      excludedUserIds: data.excludedUserIds ?? [],
    };

    // Atomic conditional push: the repository query refuses to push when a
    // view with the same (module, name) already exists, so concurrent creates
    // can no longer clobber each other via read-modify-write.
    const result = await this.settingsService.pushListView(
      this.SETTINGS_KEY,
      newView,
    );
    if (!result) {
      throw new ConflictException(
        `A view named "${data.name}" already exists for module "${data.module}"`,
      );
    }
    return newView;
  }

  async updateView(
    id: string,
    data: Partial<
      Omit<ListViewDefinition, 'id' | 'createdBy' | 'isSystemDefault'>
    >,
  ): Promise<ListViewDefinition> {
    const settings = await this.getSettings();
    const existing = settings.views.find((v) => v.id === id);
    if (!existing) throw new NotFoundException(`List view "${id}" not found`);

    // If renaming, check for duplicate name within the same module.
    const targetModule = (data.module ?? existing.module).toLowerCase();
    const targetName = (data.name ?? existing.name).toLowerCase();
    const duplicate = settings.views.find(
      (v) =>
        v.id !== id &&
        v.module.toLowerCase() === targetModule &&
        v.name.toLowerCase() === targetName,
    );
    if (duplicate) {
      throw new ConflictException(
        `A view named "${data.name ?? existing.name}" already exists for module "${data.module ?? existing.module}"`,
      );
    }

    // Atomic positional $set on the matched view only — never rewrites siblings.
    const result = await this.settingsService.updateListView(
      this.SETTINGS_KEY,
      id,
      data as Record<string, any>,
    );
    if (!result) throw new NotFoundException(`List view "${id}" not found`);

    return { ...existing, ...data };
  }

  async deleteView(id: string): Promise<void> {
    const settings = await this.getSettings();
    const existing = settings.views.find((v) => v.id === id);
    if (!existing) throw new NotFoundException(`List view "${id}" not found`);

    // Prevent deleting system defaults
    if (existing.isSystemDefault) {
      throw new NotFoundException('Cannot delete a system default view');
    }

    // Atomic $pull — removes only the targeted view.
    await this.settingsService.pullListView(this.SETTINGS_KEY, id);
  }

  // ── Internal Helpers ────────────────────────────────────────────────────

  /**
   * Check if user has OWNER or ADMIN role in the current tenant.
   */
  private async isAdminOrOwner(userId: string): Promise<boolean> {
    try {
      const user = await this.usersService.findById(userId);
      if (!user) return false;

      const tenantId = this.cls.get('tenantId');
      const membership = user.tenants?.find(
        (t) => t.tenantId?.toString() === tenantId?.toString(),
      );
      if (!membership) return false;

      return (
        membership.roles?.some((r) => r === 'OWNER' || r === 'ADMIN') ?? false
      );
    } catch {
      return false;
    }
  }

  /**
   * Get the current user's group IDs.
   */
  private async getUserGroupIds(userId: string): Promise<string[]> {
    try {
      const groups = await this.groupsService.findAll();
      return groups
        .filter((g) => g.memberIds?.includes(userId))
        .map((g) => g.id);
    } catch {
      return [];
    }
  }

  /**
   * Load list_views settings, auto-migrating missing module defaults.
   *
   * When a new module ships (e.g. Account), existing tenants already have the
   * `list_views` key so lazySeed won't fire. This method detects missing module
   * views by comparing against DEFAULTS_MAP and merges them in automatically.
   */
  private async getSettings(): Promise<ListViewsSettings> {
    const raw = await this.settingsService.getSetting(this.SETTINGS_KEY);
    if (raw && typeof raw === 'object' && Array.isArray(raw.views)) {
      // HIGH-08: merge default views in memory ONLY — the read path must never
      // write to the DB. Persistence is handled by migrateMissingDefaults()
      // on write paths.
      return this.mergeDefaults(raw as ListViewsSettings).merged;
    }
    return { views: [] };
  }

  /**
   * Compute the set of default views for modules that have none yet, returning
   * both the in-memory merged view list and the missing defaults (so callers
   * can decide whether to persist).
   */
  private mergeDefaults(settings: ListViewsSettings): {
    merged: ListViewsSettings;
    missing: ListViewDefinition[];
  } {
    const defaultListViews = DEFAULTS_MAP['list_views'] as
      | ListViewsSettings
      | undefined;
    const missing: ListViewDefinition[] = [];
    if (defaultListViews?.views) {
      const existingModules = new Set(settings.views.map((v) => v.module));
      missing.push(
        ...(defaultListViews.views.filter(
          (dv) => !existingModules.has(dv.module),
        ) as ListViewDefinition[]),
      );
    }
    return {
      merged: { ...settings, views: [...settings.views, ...missing] },
      missing,
    };
  }

  /**
   * Persist default views for modules that don't have any yet. Invoked from
   * write paths so reads never trigger a DB write (HIGH-08). Idempotent.
   */
  private async migrateMissingDefaults(): Promise<void> {
    const raw = await this.settingsService.getSetting(this.SETTINGS_KEY);
    const settings: ListViewsSettings =
      raw && typeof raw === 'object' && Array.isArray(raw.views)
        ? (raw as ListViewsSettings) // narrowed but TS needs the cast for type inference
        : { views: [] };
    const { missing } = this.mergeDefaults(settings);
    if (missing.length > 0) {
      settings.views.push(...missing);
      await this.saveSettings(settings);
      this.logger.log(
        `[ListViews] Migrated ${missing.length} default views for modules: ${[...new Set(missing.map((v) => v.module))].join(', ')}`,
      );
    }
  }

  private async saveSettings(settings: ListViewsSettings): Promise<void> {
    await this.settingsService.updateSetting(this.SETTINGS_KEY, settings);
  }

  private generateId(): string {
    // LOW-05: ULID — monotonic, collision-resistant, sortable (replaces the
    // previous Date.now()+Math.random() ad-hoc id).
    return ulid();
  }
}
