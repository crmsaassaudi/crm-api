/**
 * OrgUnitsService — tree invariants.
 *
 * The materialised `path` is not a convenience field: it is what every scoped
 * read prefix-matches on, so a wrong path is a visibility bug, not a display
 * bug. Two failure directions to hold down, and they are not symmetric:
 *
 *   - a path that is too SHORT or points at the wrong ancestor puts records in
 *     a subtree they do not belong to → data leak;
 *   - a path left stale after a reparent hides records from the people who now
 *     own them → looks like data loss.
 *
 * Hence the emphasis on reparenting, cycles, and the delete guards rather than
 * on plain CRUD.
 */

import { ConflictException, NotFoundException } from '@nestjs/common';
import { OrgUnitsService } from './org-units.service';
import { DataScope } from '../common/permissions/data-scope.enum';

const TENANT = 'tenant_1';

// A three-level tree:  root(/r/)  →  branch(/r/b/)  →  team(/r/b/t/)
const root = {
  id: 'r',
  tenantId: TENANT,
  name: 'HQ',
  parentId: null,
  path: '/r/',
  depth: 0,
  isActive: true,
};
const branch = {
  id: 'b',
  tenantId: TENANT,
  name: 'North',
  parentId: 'r',
  path: '/r/b/',
  depth: 1,
  isActive: true,
};
const team = {
  id: 't',
  tenantId: TENANT,
  name: 'North Sales',
  parentId: 'b',
  path: '/r/b/t/',
  depth: 2,
  isActive: true,
};
const sibling = {
  id: 's',
  tenantId: TENANT,
  name: 'South',
  parentId: 'r',
  path: '/r/s/',
  depth: 1,
  isActive: true,
};

const TREE = [root, branch, team, sibling];

describe('OrgUnitsService', () => {
  let service: OrgUnitsService;
  let repository: any;
  let userRepository: any;
  let cls: any;

  beforeEach(() => {
    repository = {
      findAll: jest.fn().mockResolvedValue(TREE),
      findById: jest
        .fn()
        .mockImplementation((_tenantId: string, id: string) =>
          Promise.resolve(TREE.find((unit) => unit.id === id) ?? null),
        ),
      findByCode: jest.fn().mockResolvedValue(null),
      findSubtreeIds: jest
        .fn()
        .mockImplementation((_tenantId: string, id: string) => {
          const unit = TREE.find((u) => u.id === id);
          if (!unit) return Promise.resolve([]);
          return Promise.resolve(
            TREE.filter((u) => u.path.startsWith(unit.path)).map((u) => u.id),
          );
        }),
      create: jest.fn().mockImplementation((data: any, parentPath: string) =>
        Promise.resolve({
          ...data,
          id: 'new',
          path: `${parentPath}new/`,
          depth: `${parentPath}new/`.split('/').filter(Boolean).length - 1,
        }),
      ),
      update: jest.fn().mockResolvedValue(root),
      delete: jest.fn().mockResolvedValue(true),
      countChildren: jest.fn().mockResolvedValue(0),
      rewriteSubtreePaths: jest.fn().mockResolvedValue(2),
    };
    userRepository = {
      countByOrgUnit: jest.fn().mockResolvedValue({}),
      findById: jest.fn().mockResolvedValue({
        id: 'u1',
        tenants: [{ tenantId: TENANT }],
      }),
    };
    cls = { get: jest.fn().mockReturnValue(TENANT) };

    service = new OrgUnitsService(repository, userRepository, cls);
  });

  describe('tenant context', () => {
    it('should REFUSE to operate without a tenant in CLS', async () => {
      // An unscoped read of the org tree leaks another company's structure, and
      // the tree is exactly what data scopes are keyed on. Missing context has
      // to be an error, never a broad query.
      cls.get.mockReturnValue(undefined);
      await expect(service.findAllScoped()).rejects.toThrow(
        /Tenant context is required/,
      );
      expect(repository.findAll).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('should place a root at depth 0 with a self-only path', async () => {
      const created = await service.create(TENANT, { name: 'Standalone' });
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: null }),
        '/',
      );
      expect(created.path).toBe('/new/');
      expect(created.depth).toBe(0);
    });

    it('should extend the parent path, not rebuild it', async () => {
      const created = await service.create(TENANT, {
        name: 'Sub',
        parentId: 'b',
      });
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: 'b' }),
        '/r/b/',
      );
      expect(created.path).toBe('/r/b/new/');
      expect(created.depth).toBe(2);
    });

    it('should REJECT an unknown parent rather than silently create a root', async () => {
      // Silently promoting to root would put the unit — and every record filed
      // under it — outside the subtree the caller intended.
      await expect(
        service.create(TENANT, { name: 'Orphan', parentId: 'nope' }),
      ).rejects.toThrow(NotFoundException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('should REJECT a duplicate code within the tenant', async () => {
      repository.findByCode.mockResolvedValue(branch);
      await expect(
        service.create(TENANT, { name: 'Dup', code: 'NORTH' }),
      ).rejects.toThrow(ConflictException);
    });

    it('should REJECT a manager who is not a member of the tenant', async () => {
      // Otherwise an id from another workspace becomes a view into this one via
      // a field that reads as ordinary HR metadata.
      userRepository.findById.mockResolvedValue({
        id: 'outsider',
        tenants: [{ tenantId: 'tenant_2' }],
      });
      await expect(
        service.create(TENANT, { name: 'X', managerId: 'outsider' }),
      ).rejects.toThrow(/member of this workspace/);
    });

    it('should REJECT a manager id that resolves to no user', async () => {
      userRepository.findById.mockResolvedValue(null);
      await expect(
        service.create(TENANT, { name: 'X', managerId: 'ghost' }),
      ).rejects.toThrow(/member of this workspace/);
    });
  });

  describe('reparenting', () => {
    it('should rewrite the whole subtree when a unit moves', async () => {
      await service.update(TENANT, 'b', { parentId: 's' });
      expect(repository.rewriteSubtreePaths).toHaveBeenCalledWith(
        TENANT,
        '/r/b/',
        '/r/s/b/',
      );
    });

    it('should promote to a root path when the parent is cleared', async () => {
      await service.update(TENANT, 'b', { parentId: null });
      expect(repository.rewriteSubtreePaths).toHaveBeenCalledWith(
        TENANT,
        '/r/b/',
        '/b/',
      );
    });

    it('should REFUSE a move beneath its own descendant — the cycle case', async () => {
      // /r/b/ moving under /r/b/t/ would produce a path containing itself. With
      // parent pointers this check needs a walk that may not terminate; with the
      // materialised path it is one prefix test.
      await expect(
        service.update(TENANT, 'b', { parentId: 't' }),
      ).rejects.toThrow(/beneath one of its own descendants/);
      expect(repository.rewriteSubtreePaths).not.toHaveBeenCalled();
    });

    it('should REFUSE a unit as its own parent', async () => {
      await expect(
        service.update(TENANT, 'b', { parentId: 'b' }),
      ).rejects.toThrow(/cannot be its own parent/);
    });

    it('should NOT rewrite paths when parentId is re-sent unchanged', async () => {
      // A PATCH that echoes the current parent is not a move. Rewriting anyway
      // would churn every descendant's path on every ordinary rename.
      await service.update(TENANT, 'b', { parentId: 'r', name: 'Renamed' });
      expect(repository.rewriteSubtreePaths).not.toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalled();
    });

    it('should NOT rewrite paths for an edit that omits parentId', async () => {
      await service.update(TENANT, 'b', { name: 'Renamed' });
      expect(repository.rewriteSubtreePaths).not.toHaveBeenCalled();
    });

    it('should REJECT a move under an unknown parent', async () => {
      await expect(
        service.update(TENANT, 'b', { parentId: 'nope' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should allow a lateral move between siblings', async () => {
      await service.update(TENANT, 't', { parentId: 's' });
      expect(repository.rewriteSubtreePaths).toHaveBeenCalledWith(
        TENANT,
        '/r/b/t/',
        '/r/s/t/',
      );
    });
  });

  describe('depth limit', () => {
    it('should REFUSE a create that would exceed the limit', async () => {
      repository.findById.mockResolvedValue({ ...team, depth: 9 });
      await expect(
        service.create(TENANT, { name: 'TooDeep', parentId: 't' }),
      ).rejects.toThrow(/may not exceed 10 levels/);
    });

    it('should account for the moved subtree height, not just the unit', async () => {
      // Moving a 3-tall subtree under a deep parent must consider the whole
      // subtree; checking only the moved node would let descendants exceed the
      // bound and grow the prefix key everyone else's index scans pay for.
      const deepParent = {
        ...sibling,
        id: 'deep',
        path: '/r/deep/',
        depth: 8,
      };
      repository.findById.mockImplementation((_t: string, id: string) =>
        Promise.resolve(
          id === 'deep' ? deepParent : (TREE.find((u) => u.id === id) ?? null),
        ),
      );
      await expect(
        service.update(TENANT, 'b', { parentId: 'deep' }),
      ).rejects.toThrow(/exceed the 10-level limit/);
    });
  });

  describe('remove', () => {
    it('should delete a leaf unit with no members', async () => {
      await service.remove(TENANT, 't');
      expect(repository.delete).toHaveBeenCalledWith(TENANT, 't');
    });

    it('should REFUSE to delete a unit that still has children', async () => {
      // Cascading would orphan every record whose orgUnitId no longer resolves.
      repository.countChildren.mockResolvedValue(2);
      await expect(service.remove(TENANT, 'b')).rejects.toThrow(
        ConflictException,
      );
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('should REFUSE to delete a unit that still has member users', async () => {
      // Cascading would move people into a scope nobody assigned them to.
      userRepository.countByOrgUnit.mockResolvedValue({ t: 3 });
      await expect(service.remove(TENANT, 't')).rejects.toThrow(
        /3 member\(s\)/,
      );
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('should REJECT deleting a unit that does not exist', async () => {
      await expect(service.remove(TENANT, 'nope')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findTree', () => {
    it('should nest children under their parents and attach member counts', async () => {
      userRepository.countByOrgUnit.mockResolvedValue({ r: 1, t: 4 });
      const tree = await service.findTree(TENANT);

      expect(tree).toHaveLength(1);
      expect(tree[0].id).toBe('r');
      expect(tree[0].memberCount).toBe(1);
      expect(tree[0].children.map((c) => c.id).sort()).toEqual(['b', 's']);

      const northBranch = tree[0].children.find((c) => c.id === 'b')!;
      expect(northBranch.children.map((c) => c.id)).toEqual(['t']);
      expect(northBranch.children[0].memberCount).toBe(4);
    });

    it('should report zero rather than undefined for a unit with no members', async () => {
      const tree = await service.findTree(TENANT);
      expect(tree[0].memberCount).toBe(0);
    });

    it('should SURFACE a unit whose parent is missing instead of dropping it', async () => {
      // Hiding it would make the tree look consistent while a unit — and every
      // record filed under it — silently disappeared from the UI.
      repository.findAll.mockResolvedValue([
        { ...team, parentId: 'deleted-parent' },
      ]);
      const tree = await service.findTree(TENANT);
      expect(tree.map((n) => n.id)).toEqual(['t']);
    });
  });

  describe('resolveScopeUnitIds — the bridge into data visibility', () => {
    it('should return only the own unit for ORG_UNIT', async () => {
      const ids = await service.resolveScopeUnitIds(
        TENANT,
        'b',
        DataScope.ORG_UNIT,
      );
      expect(ids).toEqual(['b']);
      expect(repository.findSubtreeIds).not.toHaveBeenCalled();
    });

    it('should return the own unit plus descendants for ORG_UNIT_SUBTREE', async () => {
      const ids = await service.resolveScopeUnitIds(
        TENANT,
        'b',
        DataScope.ORG_UNIT_SUBTREE,
      );
      expect(ids.sort()).toEqual(['b', 't']);
    });

    it.each([DataScope.SELF, DataScope.SUBORDINATES, DataScope.TENANT])(
      'should contribute nothing on the org-unit axis for %s',
      async (scope) => {
        // SELF/SUBORDINATES are owner-axis scopes; TENANT drops the owner filter
        // entirely upstream. Returning unit ids for any of them would be a
        // second, redundant widening path.
        expect(await service.resolveScopeUnitIds(TENANT, 'b', scope)).toEqual(
          [],
        );
      },
    );

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
    ])(
      'should return [] for an unassigned user (%s), under a subtree scope',
      async (_label, orgUnitId) => {
        // The important direction: an unassigned user must not fall through to
        // "sees everything" merely for being unassigned. [] contributes no rows.
        expect(
          await service.resolveScopeUnitIds(
            TENANT,
            orgUnitId as any,
            DataScope.ORG_UNIT_SUBTREE,
          ),
        ).toEqual([]);
      },
    );

    it('should return [] when the unit was deleted mid-request', async () => {
      repository.findSubtreeIds.mockResolvedValue([]);
      expect(
        await service.resolveScopeUnitIds(
          TENANT,
          'vanished',
          DataScope.ORG_UNIT_SUBTREE,
        ),
      ).toEqual([]);
    });
  });
});
