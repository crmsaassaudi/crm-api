import { DEFAULTS_MAP } from './tenant-settings-seeding.service';

interface WorkspaceRow {
  id: string;
  hidden: boolean;
  requires: string | null;
}
interface ItemRow {
  itemId: string;
  workspaces: string[];
  order: number;
}

const NAVIGATION = DEFAULTS_MAP.navigation_workspaces as {
  workspaces: WorkspaceRow[];
  items: ItemRow[];
};

/**
 * Guards the seeded sidebar layout against the two ways it silently rots.
 *
 * A new module ships, someone adds it to `member` and forgets `owner`, and the
 * person accountable for the workspace can no longer see it from their own
 * menu. Or an item points at a workspace id that no longer exists, which the
 * API rejects on write but nothing checks on the seed — so it only surfaces
 * the first time a tenant tries to save the settings screen.
 */
describe('DEFAULT_NAVIGATION_WORKSPACES', () => {
  const workspaceIds = new Set(NAVIGATION.workspaces.map((w) => w.id));

  it('should put every navigation item in the owner workspace', () => {
    const missing = NAVIGATION.items
      .filter((item) => !item.workspaces.includes('owner'))
      .map((item) => item.itemId);

    expect(missing).toEqual([]);
  });

  it('should only reference workspaces that exist', () => {
    const dangling = NAVIGATION.items.flatMap((item) =>
      item.workspaces
        .filter((id) => !workspaceIds.has(id))
        .map((id) => `${item.itemId} → ${id}`),
    );

    expect(dangling).toEqual([]);
  });

  it('should leave one visible workspace open to everyone', () => {
    // Mirrors validateNavigationSetting: without this, a member holding no
    // admin permission is offered no workspace at all.
    const reachable = NAVIGATION.workspaces.filter(
      (workspace) => !workspace.hidden && workspace.requires == null,
    );

    expect(reachable.length).toBeGreaterThan(0);
  });

  it('should not declare the same workspace id twice', () => {
    expect(workspaceIds.size).toBe(NAVIGATION.workspaces.length);
  });

  it('should not list the same item twice', () => {
    const ids = NAVIGATION.items.map((item) => item.itemId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
