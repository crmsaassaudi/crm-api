import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { OrgUnitRepository } from './infrastructure/persistence/document/repositories/org-unit.repository';
import { OrgUnit, OrgUnitTreeNode } from './domain/org-unit';
import { CreateOrgUnitDto, UpdateOrgUnitDto } from './dto/org-unit.dto';
import { UsersDocumentRepository } from '../users/infrastructure/persistence/document/repositories/user.repository';
import { DataScope } from '../common/permissions/data-scope.enum';

/**
 * Hard ceiling on tree depth.
 *
 * Not an arbitrary product limit — it bounds the cost of the visibility path.
 * `path` is stored per row and prefix-matched on every scoped read, so an
 * unbounded chain would let one tenant grow a key long enough to degrade the
 * index for everyone. Ten levels is well past any real org chart.
 */
const MAX_DEPTH = 10;

@Injectable()
export class OrgUnitsService {
  private readonly logger = new Logger(OrgUnitsService.name);

  constructor(
    private readonly repository: OrgUnitRepository,
    private readonly userRepository: UsersDocumentRepository,
    private readonly cls: ClsService,
  ) {}

  /**
   * Tenant comes from CLS — already membership-verified by TenantInterceptor —
   * and never from a caller-supplied value. Missing context is an error rather
   * than a broad query: an unscoped read of the org tree would leak another
   * tenant's structure, and the tree is exactly what data scopes are keyed on.
   */
  private requireTenantId(): string {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      throw new InternalServerErrorException('Tenant context is required');
    }
    return tenantId;
  }

  // The `*Scoped` wrappers are `async` so a missing tenant context surfaces as a
  // rejected promise like every other failure here. A synchronous throw from a
  // Promise-returning method is a trap: a caller that wraps the call in
  // `.catch()` never sees it.
  async findAllScoped(query?: {
    search?: string;
    isActive?: boolean;
    parentId?: string | null;
  }): Promise<OrgUnit[]> {
    return this.findAll(this.requireTenantId(), query);
  }

  async findTreeScoped(): Promise<OrgUnitTreeNode[]> {
    return this.findTree(this.requireTenantId());
  }

  async findByIdScoped(id: string): Promise<OrgUnit> {
    return this.findById(this.requireTenantId(), id);
  }

  async createScoped(dto: CreateOrgUnitDto): Promise<OrgUnit> {
    return this.create(this.requireTenantId(), dto);
  }

  async updateScoped(id: string, dto: UpdateOrgUnitDto): Promise<OrgUnit> {
    return this.update(this.requireTenantId(), id, dto);
  }

  async removeScoped(id: string): Promise<void> {
    return this.remove(this.requireTenantId(), id);
  }

  findAll(
    tenantId: string,
    query?: { search?: string; isActive?: boolean; parentId?: string | null },
  ): Promise<OrgUnit[]> {
    return this.repository.findAll(tenantId, query);
  }

  async findById(tenantId: string, id: string): Promise<OrgUnit> {
    const unit = await this.repository.findById(tenantId, id);
    if (!unit) throw new NotFoundException('Org unit not found');
    return unit;
  }

  /**
   * The whole tree in one read, assembled in memory.
   *
   * Rows come back sorted by `path`, so a parent always precedes its children
   * and a single pass suffices — no per-level query, and no recursion depth
   * proportional to the tree.
   */
  async findTree(tenantId: string): Promise<OrgUnitTreeNode[]> {
    const units = await this.repository.findAll(tenantId);
    const counts = await this.userRepository.countByOrgUnit(tenantId);

    const nodes = new Map<string, OrgUnitTreeNode>();
    for (const unit of units) {
      nodes.set(unit.id, {
        ...unit,
        children: [],
        memberCount: counts[unit.id] ?? 0,
      });
    }

    const roots: OrgUnitTreeNode[] = [];
    for (const unit of units) {
      const node = nodes.get(unit.id)!;
      const parent = unit.parentId ? nodes.get(unit.parentId) : undefined;
      // A node whose parent is missing (deleted out from under it) is surfaced
      // as a root rather than silently dropped — hiding it would make the tree
      // look consistent while a unit, and everything it owns, disappeared.
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  async create(tenantId: string, dto: CreateOrgUnitDto): Promise<OrgUnit> {
    const parent = dto.parentId
      ? await this.findById(tenantId, dto.parentId)
      : null;

    if (parent && parent.depth + 1 >= MAX_DEPTH) {
      throw new BadRequestException(
        `Org unit tree may not exceed ${MAX_DEPTH} levels`,
      );
    }
    await this.assertCodeAvailable(tenantId, dto.code ?? null, null);
    await this.assertManagerInTenant(tenantId, dto.managerId ?? null);

    return this.repository.create(
      {
        tenantId,
        name: dto.name,
        code: dto.code ?? null,
        description: dto.description ?? null,
        parentId: parent?.id ?? null,
        managerId: dto.managerId ?? null,
        isActive: dto.isActive ?? true,
      },
      parent ? parent.path : '/',
    );
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateOrgUnitDto,
  ): Promise<OrgUnit> {
    const current = await this.findById(tenantId, id);

    if (dto.code !== undefined) {
      await this.assertCodeAvailable(tenantId, dto.code, id);
    }
    if (dto.managerId !== undefined) {
      await this.assertManagerInTenant(tenantId, dto.managerId);
    }

    const reparenting =
      dto.parentId !== undefined &&
      String(dto.parentId ?? '') !== String(current.parentId ?? '');

    let newPath: string | null = null;
    if (reparenting) {
      newPath = await this.resolveReparent(tenantId, current, dto.parentId!);
    }

    await this.repository.update(tenantId, id, {
      name: dto.name,
      code: dto.code,
      description: dto.description,
      parentId: reparenting ? (dto.parentId ?? null) : undefined,
      managerId: dto.managerId,
      isActive: dto.isActive,
    });

    if (newPath) {
      const moved = await this.repository.rewriteSubtreePaths(
        tenantId,
        current.path,
        newPath,
      );
      this.logger.log(
        `Org unit ${id} reparented; rewrote ${moved} path(s) under ${newPath}`,
      );
    }

    return this.findById(tenantId, id);
  }

  /**
   * Deleting a unit is refused while anything still points at it — children or
   * member users. Cascading would either orphan records whose `orgUnitId` no
   * longer resolves, or silently move people into a scope they were never
   * assigned to; both are worse than making the caller be explicit.
   */
  async remove(tenantId: string, id: string): Promise<void> {
    await this.findById(tenantId, id);

    const children = await this.repository.countChildren(tenantId, id);
    if (children > 0) {
      throw new ConflictException(
        `Org unit has ${children} child unit(s); move or delete them first`,
      );
    }

    const members = await this.userRepository.countByOrgUnit(tenantId);
    if ((members[id] ?? 0) > 0) {
      throw new ConflictException(
        `Org unit has ${members[id]} member(s); reassign them first`,
      );
    }

    await this.repository.delete(tenantId, id);
  }

  /**
   * The org-unit ids a principal may see under a given scope. Consumed by
   * DataVisibilityInterceptor; kept here so the tree semantics live with the
   * tree.
   *
   *   ORG_UNIT          → the principal's own unit only
   *   ORG_UNIT_SUBTREE  → own unit plus descendants
   *   anything narrower → [] (the org-unit axis contributes nothing)
   *
   * A principal with no org unit gets [] under every scope. That is deliberate:
   * an unassigned user must not fall through to "sees everything" merely for
   * being unassigned, which is exactly how the scope-with-no-data case turns
   * into a leak.
   */
  async resolveScopeUnitIds(
    tenantId: string,
    orgUnitId: string | null | undefined,
    scope: DataScope,
  ): Promise<string[]> {
    if (!orgUnitId) return [];
    if (scope === DataScope.ORG_UNIT) return [String(orgUnitId)];
    if (scope === DataScope.ORG_UNIT_SUBTREE) {
      return this.repository.findSubtreeIds(tenantId, String(orgUnitId));
    }
    return [];
  }

  /**
   * Validate a move and return the destination path.
   *
   * The cycle check is the whole reason `path` is materialised: a unit may not
   * be moved under one of its own descendants, and with the path in hand that
   * is a single prefix test instead of walking parent pointers (which, if a
   * cycle already existed, would not terminate).
   */
  private async resolveReparent(
    tenantId: string,
    current: OrgUnit,
    newParentId: string | null,
  ): Promise<string> {
    if (!newParentId) return `/${current.id}/`;

    if (String(newParentId) === String(current.id)) {
      throw new BadRequestException('An org unit cannot be its own parent');
    }

    const parent = await this.repository.findById(tenantId, newParentId);
    if (!parent) throw new NotFoundException('Parent org unit not found');

    if (parent.path.startsWith(current.path)) {
      throw new BadRequestException(
        'Cannot move an org unit beneath one of its own descendants',
      );
    }

    const subtreeDepth = await this.measureSubtreeDepth(tenantId, current);
    if (parent.depth + 1 + subtreeDepth >= MAX_DEPTH) {
      throw new BadRequestException(
        `Move would exceed the ${MAX_DEPTH}-level limit`,
      );
    }

    return `${parent.path}${current.id}/`;
  }

  /** Height of the subtree below `unit` (0 when it is a leaf). */
  private async measureSubtreeDepth(
    tenantId: string,
    unit: OrgUnit,
  ): Promise<number> {
    const ids = await this.repository.findSubtreeIds(tenantId, unit.id);
    if (ids.length <= 1) return 0;
    const units = await this.repository.findAll(tenantId);
    const inSubtree = units.filter((u) => ids.includes(u.id));
    const deepest = Math.max(...inSubtree.map((u) => u.depth));
    return deepest - unit.depth;
  }

  private async assertCodeAvailable(
    tenantId: string,
    code: string | null,
    selfId: string | null,
  ): Promise<void> {
    if (!code) return;
    const existing = await this.repository.findByCode(tenantId, code);
    if (existing && existing.id !== selfId) {
      throw new ConflictException(`Org unit code "${code}" is already in use`);
    }
  }

  /**
   * A unit's manager must be a member of the same tenant. Without this, a
   * caller could name an id from another workspace and — once manager-based
   * scope resolution reads it — hand that outsider a view into this tenant.
   */
  private async assertManagerInTenant(
    tenantId: string,
    managerId: string | null,
  ): Promise<void> {
    if (!managerId) return;
    const user = await this.userRepository.findById(managerId);
    const isMember = user?.tenants?.some(
      (membership: any) => String(membership.tenantId) === String(tenantId),
    );
    if (!isMember) {
      throw new BadRequestException(
        'Manager must be a member of this workspace',
      );
    }
  }
}
