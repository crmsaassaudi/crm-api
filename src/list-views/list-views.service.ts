import { Injectable, NotFoundException } from '@nestjs/common';
import { CrmSettingsService } from '../crm-settings/crm-settings.service';
import { GroupsService } from '../groups/groups.service';
import { ClsService } from 'nestjs-cls';
import { UsersService } from '../users/users.service';

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

    // Find views assigned to any of the user's groups, excluding views where user is explicitly excluded
    const groupViews = moduleViews.filter(
      (v) =>
        !v.isSystemDefault &&
        v.assignedGroupIds.some((gId) => userGroupIds.includes(gId)) &&
        !(v.excludedUserIds || []).includes(userId),
    );

    // If agent has group views → return only those
    if (groupViews.length > 0) {
      return groupViews;
    }

    // Fallback: no group view assigned → return system default only
    return moduleViews.filter((v) => v.isSystemDefault);
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
    data: Omit<ListViewDefinition, 'id' | 'createdBy' | 'isSystemDefault'>,
  ): Promise<ListViewDefinition> {
    const settings = await this.getSettings();
    const userId = this.cls.get('userId') || 'system';

    const newView: ListViewDefinition = {
      ...data,
      id: this.generateId(),
      createdBy: userId,
      isSystemDefault: false,
    };

    settings.views.push(newView);
    await this.saveSettings(settings);
    return newView;
  }

  async updateView(
    id: string,
    data: Partial<
      Omit<ListViewDefinition, 'id' | 'createdBy' | 'isSystemDefault'>
    >,
  ): Promise<ListViewDefinition> {
    const settings = await this.getSettings();
    const index = settings.views.findIndex((v) => v.id === id);
    if (index === -1)
      throw new NotFoundException(`List view "${id}" not found`);

    settings.views[index] = { ...settings.views[index], ...data };
    await this.saveSettings(settings);
    return settings.views[index];
  }

  async deleteView(id: string): Promise<void> {
    const settings = await this.getSettings();
    const index = settings.views.findIndex((v) => v.id === id);
    if (index === -1)
      throw new NotFoundException(`List view "${id}" not found`);

    // Prevent deleting system defaults
    if (settings.views[index].isSystemDefault) {
      throw new NotFoundException('Cannot delete a system default view');
    }

    settings.views.splice(index, 1);
    await this.saveSettings(settings);
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

  private async getSettings(): Promise<ListViewsSettings> {
    const raw = await this.settingsService.getSetting(this.SETTINGS_KEY);
    if (raw && typeof raw === 'object' && Array.isArray(raw.views)) {
      return raw as ListViewsSettings;
    }
    return { views: [] };
  }

  private async saveSettings(settings: ListViewsSettings): Promise<void> {
    await this.settingsService.updateSetting(this.SETTINGS_KEY, settings);
  }

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
  }
}
