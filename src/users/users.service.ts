import {
  HttpStatus,
  Injectable,
  Inject,
  forwardRef,
  UnprocessableEntityException,
  ForbiddenException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { BusinessException } from '../common/exceptions/business.exception';
import { USER_ERRORS } from './constants/user-error-codes';
import { CreateUserDto } from './dto/create-user.dto';
import { NullableType } from '../utils/types/nullable.type';
import { FilterUserDto, SortUserDto } from './dto/query-user.dto';
import { UserRepository } from './infrastructure/persistence/user.repository';
import { User } from './domain/user';
import bcrypt from 'bcryptjs';
import { AuthProvidersEnum } from '../auth/auth-providers.enum';
import { FilesService } from '../files/files.service';
import { PlatformRoleEnum } from '../roles/platform-role.enum';
import { TenantRoleEnum } from '../roles/tenant-role.enum';
import { StatusEnum } from '../statuses/statuses.enum';
import { IPaginationOptions } from '../utils/types/pagination-options';
import { FileType } from '../files/domain/file';
import { Role } from '../roles/domain/role';
import { Status } from '../statuses/domain/status';
import { UpdateUserDto } from './dto/update-user.dto';
import { ClsService } from 'nestjs-cls';
import { ModuleRef } from '@nestjs/core';
import { OrgUnitRepository } from '../org-units/infrastructure/persistence/document/repositories/org-unit.repository';
import { GroupsService } from '../groups/groups.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { KeycloakAdminService } from '../auth/services/keycloak-admin.service';
import { SessionService } from '../auth/services/session.service';
import { InviteUserDto } from './dto/invite-user.dto';
import { PaginationResponseDto } from '../utils/dto/pagination-response.dto';
import { TenantsRepository } from '../tenants/infrastructure/persistence/document/repositories/tenant.repository';
import { GroupRepository } from '../groups/infrastructure/persistence/document/repositories/group.repository';
import { AuthzAuditService } from '../common/authz-audit/authz-audit.service';
import { CustomRolesService } from '../common/permissions/custom-roles.service';
import { AuthzPermissionCacheService } from '../common/permissions/authz-permission-cache.service';
import { ALL_PERMISSIONS } from '../common/permissions/permission.constants';
import { getTenantId, getUserId } from '../common/cls/cls-context.helper';
import { DEFAULT_BASELINE_SYSTEM_KEY } from '../common/permissions/system-role-templates';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly usersRepository: UserRepository,
    private readonly filesService: FilesService,
    private readonly cls: ClsService,
    @Inject(forwardRef(() => KeycloakAdminService))
    private readonly keycloakAdminService: KeycloakAdminService,
    @Inject(forwardRef(() => SessionService))
    private readonly sessionService: SessionService,
    private readonly tenantsRepository: TenantsRepository,
    private readonly groupRepository: GroupRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly audit: AuthzAuditService,
    private readonly customRoles: CustomRolesService,
    private readonly authzCache: AuthzPermissionCacheService,
    // Lazy lookups only (OrgUnitRepository). OrgUnitsModule already imports
    // UsersModule, so a direct injection here would close the cycle.
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Reject role references that do not exist in the active tenant's custom-role
   * catalog. Prevents dangling / cross-tenant roleIds being persisted on a
   * membership (they would otherwise resolve to no permissions silently).
   */
  private async assertRoleIdsBelongToTenant(
    tenantId: string,
    roleIds?: string[],
  ): Promise<void> {
    if (!roleIds?.length) return;
    const tenantRoles = await this.customRoles.findAll(tenantId);
    const validIds = new Set(tenantRoles.map((r) => String(r.id)));
    const unknown = roleIds.filter((id) => !validIds.has(String(id)));
    if (unknown.length) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: {
          roleIds: `Unknown role(s) for this tenant: ${unknown.join(', ')}`,
        },
      });
    }
  }

  /**
   * An `orgUnitId` must name a unit in the tenant the caller is acting in.
   *
   * Resolved through OrgUnitRepository with the tenant supplied explicitly, so
   * the lookup cannot be satisfied by a unit from another workspace even if the
   * caller knows a valid id. A missing unit is a 422, not a silent null: quietly
   * dropping the value would leave the user unassigned while the UI reported
   * success.
   */
  private async assertOrgUnitInTenant(
    tenantId: string,
    orgUnitId: string,
  ): Promise<void> {
    const orgUnits = this.moduleRef.get(OrgUnitRepository, { strict: false });
    const unit = await orgUnits.findById(tenantId, String(orgUnitId));
    if (!unit) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: { orgUnitId: 'Unknown org unit for this tenant' },
      });
    }
  }

  /**
   * The org placement a new member starts with: unit, manager, groups.
   *
   * Resolved BEFORE the user is written so a bad id fails the whole invite
   * rather than leaving a half-placed member behind. Both fall back to the
   * inviter's own placement, which is almost always right — people invite into
   * their own team — and is far better than the alternative of null, where
   * every ORG_UNIT scope resolves to an empty set and the new member logs in to
   * five empty modules.
   */
  private async resolvePlacement(
    tenantId: string,
    dto: { orgUnitId?: string; reportsToId?: string },
  ): Promise<{ orgUnitId: string | null; reportsToId: string | null }> {
    if (dto.orgUnitId) {
      await this.assertOrgUnitInTenant(tenantId, dto.orgUnitId);
    }
    if (dto.reportsToId) {
      await this.assertUserInTenant(tenantId, dto.reportsToId);
    }

    const inviterId = this.cls.get<string>('userId');
    const inviter = inviterId
      ? await this.usersRepository.findById(inviterId)
      : null;
    const inviterUnit = inviter?.tenants?.find(
      (membership) => String(membership.tenantId) === String(tenantId),
    )?.orgUnitId;

    return {
      orgUnitId: dto.orgUnitId ?? inviterUnit ?? null,
      // The inviter as default manager mirrors how the invite actually happened.
      reportsToId: dto.reportsToId ?? (inviterId ? String(inviterId) : null),
    };
  }

  /** A referenced principal must be a member of the acting tenant. */
  private async assertUserInTenant(
    tenantId: string,
    userId: string,
  ): Promise<void> {
    const user = await this.usersRepository.findById(userId);
    const isMember = user?.tenants?.some(
      (membership: any) => String(membership.tenantId) === String(tenantId),
    );
    if (!isMember) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: { reportsToId: 'Manager is not a member of this tenant' },
      });
    }
  }

  /**
   * Add a brand-new member to the groups the inviter picked.
   *
   * Separate from org placement because the two are written differently:
   * `orgUnitId` / `reportsToId` live on the membership and are set when it is
   * created, while group membership is its own collection. Routed through
   * `GroupsService.addMember` so the "cannot grant what you do not hold"
   * invariant still applies to whatever roles a group carries.
   */
  private async joinGroups(user: User, groupIds?: string[]): Promise<void> {
    if (!groupIds?.length) return;
    // Resolved lazily rather than injected: GroupsModule already depends on
    // UsersModule, and a second eager edge back is how this codebase last
    // deadlocked its own bootstrap.
    const groups = this.moduleRef.get(GroupsService, { strict: false });
    for (const groupId of groupIds) {
      await groups.addMember(groupId, String(user.id));
    }
  }

  /**
   * Decide which role references a brand-new membership starts with.
   *
   * A membership with no roleIds resolves to ZERO permissions (only OWNER/ADMIN
   * short-circuit), so an invite without a role produces a user who logs in and
   * sees nothing. When the caller picks nothing we fall back to the built-in
   * Read Only baseline — the same least-privilege default Salesforce moved to
   * with its "Minimum Access" profile.
   */
  private async resolveBaselineRoleIds(
    tenantId: string,
    roleIds?: string[],
  ): Promise<string[]> {
    if (roleIds?.length) {
      await this.assertRoleIdsBelongToTenant(tenantId, roleIds);
      return roleIds.map(String);
    }
    const baseline = await this.customRoles.findBySystemKey(
      tenantId,
      DEFAULT_BASELINE_SYSTEM_KEY,
    );
    if (baseline) return [String(baseline.id)];

    // Tenant predates system roles and hasn't been backfilled yet.
    this.logger.warn(
      `Tenant ${tenantId} has no "${DEFAULT_BASELINE_SYSTEM_KEY}" role — new member starts with no permissions. Run: npm run seed:system-roles`,
    );
    return [];
  }

  /**
   * Reject ad-hoc permission keys / override keys that are not in the permission
   * registry. The engine already bounds effective perms by the tenant ceiling at
   * read time, but invalid keys should never be persisted (typos, stale keys,
   * cross-app strings). Mirrors custom-roles.validatePermissions for the
   * membership write path.
   */
  private assertPermissionKeysValid(
    permissions?: string[],
    permissionOverrides?: Record<string, boolean>,
  ): void {
    const registry = new Set(ALL_PERMISSIONS);
    const invalid = [
      ...(permissions ?? []),
      ...Object.keys(permissionOverrides ?? {}),
    ].filter((key) => !registry.has(key));
    if (invalid.length) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: {
          permissions: `Unknown permission key(s): ${[...new Set(invalid)].join(', ')}`,
        },
      });
    }
  }

  /**
   * The core anti-escalation invariant (C-04):
   *
   *   A principal may never grant a permission it does not itself hold.
   *
   * Without this, `users:update` is equivalent to full tenant admin: the holder
   * writes any registry key onto their own — or anyone's — membership and
   * re-reads it as an effective permission on the next request. Key-registry
   * validation alone does not constrain this at all; it only rejects typos.
   *
   * The caller's own effective set is the authority, so the check is:
   *   requested ⊆ callerEffective
   *
   * Owner / tenant-ADMIN / platform SUPER_ADMIN hold the whole tenant ceiling,
   * so they pass trivially and need no special case.
   */
  private async assertCallerCanGrant(
    tenantId: string,
    requestedKeys: string[],
  ): Promise<void> {
    if (!requestedKeys.length) return;

    const callerId = this.cls.get<string>('userId');
    if (!callerId) {
      throw new ForbiddenException(
        'Cannot resolve the acting principal; permission grant refused',
      );
    }

    const explanation = await this.authzCache.explainForUser(
      String(callerId),
      tenantId,
    );

    // fullAccess = owner / admin / super-admin → holds the entire ceiling.
    const held = explanation.fullAccess
      ? new Set(explanation.tenantCeiling)
      : new Set(explanation.effective);

    const escalating = [...new Set(requestedKeys)].filter(
      (key) => !held.has(key),
    );

    if (escalating.length) {
      throw new ForbiddenException({
        status: HttpStatus.FORBIDDEN,
        errors: {
          permissions: `You cannot grant permission(s) you do not hold yourself: ${escalating.join(', ')}`,
        },
      });
    }
  }

  /**
   * The same anti-escalation invariant, for the one grant that is not a
   * permission key: `tenants[].roles`.
   *
   * `ADMIN` is not an ordinary role — it seeds the membership with the entire
   * tenant ceiling (`permission.engine.ts`) and bypasses every data-visibility
   * axis (`data-visibility.interceptor.ts`). Writing it is therefore the widest
   * grant in the system, and it was reachable from `POST /users/invite` and
   * `POST /users/create-for-tenant` with nothing but `users:create` — while the
   * equivalent `PATCH /users/:id/tenant-role` demanded `users:manage_roles`.
   * Anyone able to add a teammate could mint themselves a second, fully
   * privileged account.
   *
   * `OWNER` is refused outright on these paths: ownership derives from
   * `tenant.ownerId` and is transferred, never handed out at invite time.
   */
  private async assertCallerCanGrantTenantRole(
    tenantId: string,
    tenantRole: string,
  ): Promise<void> {
    const role = String(tenantRole).toUpperCase();

    if (role === TenantRoleEnum.OWNER) {
      throw new ForbiddenException({
        status: HttpStatus.FORBIDDEN,
        errors: {
          tenantRole:
            'Ownership cannot be granted here. Transfer ownership instead.',
        },
      });
    }

    if (role !== TenantRoleEnum.ADMIN) return;

    const callerId = this.cls.get<string>('userId');
    if (!callerId) {
      throw new ForbiddenException(
        'Cannot resolve the acting principal; administrator grant refused',
      );
    }

    const explanation = await this.authzCache.explainForUser(
      String(callerId),
      tenantId,
    );
    if (!explanation.fullAccess) {
      throw new ForbiddenException({
        status: HttpStatus.FORBIDDEN,
        errors: {
          tenantRole:
            'Only an administrator or the workspace owner can grant administrator access.',
        },
      });
    }
  }

  /**
   * Editing your own membership is always privilege self-service, so it is
   * refused outright — even when the caller holds `users:update`. Separation of
   * duties: another admin makes the change, and the audit log names them.
   */
  private assertNotSelfPrivilegeEdit(targetUserId: string): void {
    const callerId = this.cls.get<string>('userId');
    if (callerId && String(callerId) === String(targetUserId)) {
      throw new ForbiddenException({
        status: HttpStatus.FORBIDDEN,
        errors: {
          id: 'You cannot change your own roles or permissions. Ask another administrator.',
        },
      });
    }
  }

  /**
   * Kill live sessions when an update takes away standing access — deactivation
   * or a platformRole downgrade from SUPER_ADMIN — so the change takes effect
   * immediately instead of waiting out the session's 24h TTL.
   */
  private async revokeSessionsOnPrivilegeDowngrade(
    before: User | null,
    after: User,
  ): Promise<void> {
    const deactivated =
      before?.status?.id === StatusEnum.active &&
      after.status?.id !== undefined &&
      after.status.id !== StatusEnum.active;
    const superAdminDowngraded =
      before?.platformRole?.id === PlatformRoleEnum.SUPER_ADMIN &&
      after.platformRole?.id !== undefined &&
      after.platformRole.id !== PlatformRoleEnum.SUPER_ADMIN;

    if (!deactivated && !superAdminDowngraded) return;

    try {
      await this.sessionService.deleteAllSessionsForUser(String(after.id));
    } catch (err: any) {
      this.logger.warn(
        `Failed to revoke sessions for user ${after.id}: ${err.message}`,
      );
    }
  }

  /**
   * Expand role references into the permission keys they carry, so granting a
   * role is held to the same ceiling as granting the keys directly. Otherwise
   * the invariant is trivially bypassed by wrapping keys in a role.
   */
  private async expandRoleIdsToKeys(
    tenantId: string,
    roleIds?: string[],
  ): Promise<string[]> {
    if (!roleIds?.length) return [];
    const tenantRoles = await this.customRoles.findAll(tenantId);
    const byId = new Map(tenantRoles.map((role) => [String(role.id), role]));
    return roleIds.flatMap(
      (roleId) => byId.get(String(roleId))?.permissions ?? [],
    );
  }

  async create(
    createUserDto: CreateUserDto,
    tenantId?: string,
    session?: any,
  ): Promise<User> {
    // Do not remove comment below.
    // <creating-property />

    let password: string | undefined = undefined;

    if (createUserDto.password) {
      const salt = await bcrypt.genSalt();
      password = await bcrypt.hash(createUserDto.password, salt);
    }

    let email: string | null = null;

    if (createUserDto.email) {
      const userObject = await this.usersRepository.findByEmail(
        createUserDto.email,
      );
      if (userObject) {
        throw new UnprocessableEntityException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          errors: {
            email: 'emailAlreadyExists',
          },
        });
      }
      email = createUserDto.email;
    }

    let photo: FileType | null | undefined = undefined;

    if (createUserDto.photo?.id) {
      const fileObject = await this.filesService.findById(
        createUserDto.photo.id,
      );
      if (!fileObject) {
        throw new UnprocessableEntityException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          errors: {
            photo: 'imageNotExists',
          },
        });
      }
      photo = fileObject;
    } else if (createUserDto.photo === null) {
      photo = null;
    }

    let platformRole: Role | undefined = undefined;

    if (createUserDto.platformRole?.id) {
      platformRole = { id: createUserDto.platformRole.id as PlatformRoleEnum };
    }

    let status: Status | undefined = undefined;

    if (createUserDto.status?.id) {
      status = { id: createUserDto.status.id as StatusEnum };
    }

    return this.usersRepository.create(
      {
        // Do not remove comment below.
        // <creating-property-payload />
        tenants: tenantId
          ? [{ tenantId: tenantId, roles: [], joinedAt: new Date() }]
          : [],
        firstName: createUserDto.firstName,
        lastName: createUserDto.lastName,
        email: email,
        password: password,
        photo: photo,
        platformRole: platformRole,
        status: status,
        provider: createUserDto.provider ?? AuthProvidersEnum.email,
        keycloakId: createUserDto.keycloakId,
      },
      session,
    );
  }

  getTenantId() {
    return this.cls.get('tenantId');
  }

  async findManyByTenant(tenantId: string): Promise<User[]> {
    return this.usersRepository.findManyByTenant(tenantId);
  }

  searchByTenant(
    tenantId: string,
    params: { search?: string; page: number; limit: number },
  ): Promise<{ data: User[]; totalItems: number }> {
    return this.usersRepository.searchByTenant(tenantId, params);
  }

  findManyWithPagination({
    filterOptions,
    sortOptions,
    paginationOptions,
  }: {
    filterOptions?: FilterUserDto | null;
    sortOptions?: SortUserDto[] | null;
    paginationOptions: IPaginationOptions;
  }): Promise<PaginationResponseDto<User>> {
    return this.usersRepository.findManyWithPagination({
      filterOptions,
      sortOptions,
      paginationOptions,
    });
  }

  findById(id: User['id']): Promise<NullableType<User>> {
    return this.usersRepository.findById(id);
  }

  findByIds(ids: User['id'][]): Promise<User[]> {
    return this.usersRepository.findByIds(ids);
  }

  /** Resolve user names across tenant boundary (e.g. agent names in conversation sessions) */
  findByIdsGlobal(ids: User['id'][]): Promise<User[]> {
    return this.usersRepository.findByIdsGlobal(ids);
  }

  findByEmail(email: User['email']): Promise<NullableType<User>> {
    return this.usersRepository.findByEmail(email);
  }

  findByKeycloakIdAndProvider({
    keycloakId,
    provider,
  }: {
    keycloakId: User['keycloakId'];
    provider: User['provider'];
  }): Promise<NullableType<User>> {
    return this.usersRepository.findByKeycloakIdAndProvider({
      keycloakId,
      provider,
    });
  }

  async update(
    id: User['id'],
    updateUserDto: UpdateUserDto,
  ): Promise<User | null> {
    // Do not remove comment below.
    // <updating-property />

    const password = await this.resolveUpdatedPassword(id, updateUserDto);
    const email = await this.resolveUpdatedEmail(id, updateUserDto);
    const photo = await this.resolveUpdatedPhoto(updateUserDto);

    // Only SUPER_ADMIN may change platformRole or status
    const callerUser = await this.usersRepository.findById(
      this.cls.get('userId'),
    );
    const isSuperAdmin =
      callerUser?.platformRole?.id === PlatformRoleEnum.SUPER_ADMIN;

    const platformRole: Role | undefined =
      updateUserDto.platformRole?.id && isSuperAdmin
        ? { id: updateUserDto.platformRole.id }
        : undefined;

    const status: Status | undefined =
      updateUserDto.status?.id && isSuperAdmin
        ? { id: updateUserDto.status.id }
        : undefined;

    // Target's prior state — single source for membership + platformRole audit.
    const targetBefore = await this.usersRepository.findById(id);

    // RBAC assignment: allow updating the ACTIVE tenant membership's role
    // references / ad-hoc permissions / overrides only. Other tenants and the
    // tenant-`roles` (OWNER/ADMIN…) are NOT mutable via this path — that
    // prevents cross-tenant tampering and self-escalation of tenant role.
    const activeTenantId = this.cls.get<string>('tenantId');
    const incomingMembership = Array.isArray((updateUserDto as any).tenants)
      ? (updateUserDto as any).tenants.find(
          (t: any) => String(t.tenantId) === String(activeTenantId),
        )
      : undefined;
    if (activeTenantId && incomingMembership?.roleIds) {
      await this.assertRoleIdsBelongToTenant(
        activeTenantId,
        incomingMembership.roleIds,
      );
    }
    if (
      activeTenantId &&
      (incomingMembership?.permissions ||
        incomingMembership?.permissionOverrides)
    ) {
      this.assertPermissionKeysValid(
        incomingMembership.permissions,
        incomingMembership.permissionOverrides,
      );
    }

    // Standing ALLOW exceptions have no approval, no expiry and no reusable
    // identity, so `permissionOverrides` is deny-only — the engine ignores a
    // stored `true`, and accepting one here would persist a grant that silently
    // does nothing. Widening goes through a role or a governed RoleAssignment.
    if (activeTenantId && incomingMembership) {
      const previousMembership = targetBefore?.tenants?.find(
        (membership) => String(membership.tenantId) === String(activeTenantId),
      );
      const addedAllowOverrides = Object.entries(
        incomingMembership.permissionOverrides ?? {},
      )
        .filter(
          ([key, value]) =>
            value === true &&
            previousMembership?.permissionOverrides?.[key] !== true,
        )
        .map(([key]) => key);
      if (addedAllowOverrides.length) {
        throw new BadRequestException({
          status: 400,
          errors: {
            permissions:
              'Allow overrides are disabled. Assign a custom role or submit a governed time-bound role assignment.',
          },
        });
      }
    }

    // Anti-escalation
    // Any membership change that widens privilege is held to two rules:
    //   1. you cannot edit your own privileges at all;
    //   2. you cannot grant a key you do not hold.
    // Roles are expanded to their keys so wrapping keys in a role is not a
    // bypass. Only ALLOW directions are checked — revoking is not escalation.
    if (activeTenantId && incomingMembership) {
      const grantedKeys = await this.expandRoleIdsToKeys(
        activeTenantId,
        incomingMembership.roleIds,
      );

      if (grantedKeys.length) {
        this.assertNotSelfPrivilegeEdit(String(id));
        await this.assertCallerCanGrant(activeTenantId, grantedKeys);
      }
    }

    // An org unit id must belong to the ACTIVE tenant. Without this, an
    // admin could file a user under a unit from another workspace, and once
    // ORG_UNIT scope resolves that unit's subtree the user would read across the
    // tenant boundary — through a field that looks like plain HR metadata.
    if (activeTenantId && updateUserDto.orgUnitId) {
      await this.assertOrgUnitInTenant(activeTenantId, updateUserDto.orgUnitId);
    }

    const tenants = this.resolveMembershipUpdate(targetBefore, updateUserDto);

    const updated = await this.usersRepository.update(id, {
      // Do not remove comment below.
      // <updating-property-payload />
      firstName: updateUserDto.firstName,
      lastName: updateUserDto.lastName,
      email,
      password,
      photo,
      platformRole,
      status,
      provider: isSuperAdmin ? updateUserDto.provider : undefined,
      keycloakId: isSuperAdmin ? updateUserDto.keycloakId : undefined,
      version: updateUserDto.version,
      omniMaxCapacity: updateUserDto.omniMaxCapacity,
      skills: updateUserDto.skills,
      // `orgUnitId` / `reportsToId` are NOT passed here: they live on the
      // active tenant's membership and are folded in by
      // `resolveMembershipUpdate` below.
      // Only include when there is an actual membership change — passing
      // tenants: undefined would wipe all memberships via the mapper.
      ...(tenants !== undefined ? { tenants } : {}),
    });
    if (updated) {
      this.emitUserPermissionsUpdated(updated);
      if (
        updateUserDto.skills !== undefined ||
        updateUserDto.omniMaxCapacity !== undefined
      ) {
        this.emitUserProfileUpdated(updated, {
          skills: updateUserDto.skills,
          omniMaxCapacity: updateUserDto.omniMaxCapacity,
        });
      }
      this.auditUpdate(String(id), targetBefore, updated, {
        membershipChanged: tenants !== undefined,
        platformRoleChanged: platformRole !== undefined,
      });
      await this.revokeSessionsOnPrivilegeDowngrade(targetBefore, updated);
    }
    return updated;
  }

  /** Record MEMBERSHIP / PLATFORM_ROLE governance events (best-effort). */
  private auditUpdate(
    userId: string,
    before: User | null,
    after: User,
    changed: { membershipChanged: boolean; platformRoleChanged: boolean },
  ): void {
    const activeTenantId = this.cls.get<string>('tenantId');
    const membershipOf = (u: User | null) =>
      u?.tenants?.find((t) => String(t.tenantId) === String(activeTenantId));

    if (changed.membershipChanged) {
      const b = membershipOf(before);
      const a = membershipOf(after);
      void this.audit.record({
        category: 'MEMBERSHIP',
        action: 'assign',
        targetType: 'user',
        targetId: userId,
        summary: `updated tenant roles/permissions for user ${userId}`,
        before: b && {
          roleIds: b.roleIds,
          permissionOverrides: b.permissionOverrides,
        },
        after: a && {
          roleIds: a.roleIds,
          permissionOverrides: a.permissionOverrides,
        },
      });
    }

    if (changed.platformRoleChanged) {
      void this.audit.record({
        category: 'PLATFORM_ROLE',
        action: 'update',
        targetType: 'user',
        targetId: userId,
        summary: `changed platformRole for user ${userId}`,
        before: { platformRole: before?.platformRole?.id ?? null },
        after: { platformRole: after.platformRole?.id ?? null },
      });
    }
  }

  /**
   * Merge an incoming membership update for the ACTIVE tenant only.
   *
   * Returns the full tenants array to persist, or undefined when there is
   * nothing to change. Mutable here: `roleIds`, `permissionOverrides`, and the
   * org placement (`orgUnitId` / `reportsToId`). Tenant `roles` and every other
   * tenant's membership are left untouched — a write against one workspace must
   * never reach into another.
   *
   * Placement arrives as top-level DTO fields because that is how the profile
   * form posts it, but it is stored per-membership, so it is folded in here
   * rather than written to the user document.
   */
  private resolveMembershipUpdate(
    existing: User | null,
    dto: UpdateUserDto,
  ): User['tenants'] | undefined {
    const activeTenantId = this.cls.get('tenantId');
    if (!activeTenantId) return undefined;
    if (!existing?.tenants?.length) return undefined;

    const incomingTenants = (dto as any).tenants;
    const incoming: any = Array.isArray(incomingTenants)
      ? incomingTenants.find(
          (t: any) => String(t.tenantId) === String(activeTenantId),
        )
      : undefined;

    const placementChanged =
      dto.orgUnitId !== undefined || dto.reportsToId !== undefined;
    if (!incoming && !placementChanged) return undefined;

    return existing.tenants.map((m) =>
      String(m.tenantId) === String(activeTenantId)
        ? {
            ...m,
            roleIds: incoming?.roleIds ?? m.roleIds,
            permissionOverrides:
              incoming?.permissionOverrides ?? m.permissionOverrides,
            orgUnitId: dto.orgUnitId ?? m.orgUnitId,
            reportsToId: dto.reportsToId ?? m.reportsToId,
          }
        : m,
    );
  }

  private async resolveUpdatedPassword(
    id: User['id'],
    dto: UpdateUserDto,
  ): Promise<string | undefined> {
    if (!dto.password) return undefined;
    const existing = await this.usersRepository.findById(id);
    if (existing?.password === dto.password) return undefined;
    const salt = await bcrypt.genSalt();
    return bcrypt.hash(dto.password, salt);
  }

  private async resolveUpdatedEmail(
    id: User['id'],
    dto: UpdateUserDto,
  ): Promise<string | null | undefined> {
    if (dto.email === null) return null;
    if (!dto.email) return undefined;
    const existing = await this.usersRepository.findByEmail(dto.email);
    if (existing && existing.id !== id) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: { email: 'emailAlreadyExists' },
      });
    }
    return dto.email;
  }

  private async resolveUpdatedPhoto(
    dto: UpdateUserDto,
  ): Promise<FileType | null | undefined> {
    if (dto.photo === null) return null;
    if (!dto.photo?.id) return undefined;
    const file = await this.filesService.findById(dto.photo.id);
    if (!file) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: { photo: 'imageNotExists' },
      });
    }
    return file;
  }

  async remove(id: User['id']): Promise<void> {
    const ownedTenants = await this.tenantsRepository.findByOwnerId(
      id.toString(),
    );
    if (ownedTenants.length > 0) {
      throw new UnprocessableEntityException(
        'Cannot delete a user who owns a tenant. Transfer ownership or delete the tenant first.',
      );
    }

    // Fetch before deletion so we know which tenant caches to invalidate
    const user = await this.usersRepository.findById(id);
    await this.usersRepository.remove(id);
    if (user) this.emitUserPermissionsUpdated(user);
  }

  async invite(inviteUserDto: InviteUserDto): Promise<User> {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new UnprocessableEntityException('Tenant context missing');
    }

    const tenant = await this.tenantsRepository.findById(tenantId);
    if (!tenant) {
      throw new UnprocessableEntityException('Tenant not found');
    }

    const tenantRole = inviteUserDto.tenantRole ?? 'MEMBER';
    await this.assertCallerCanGrantTenantRole(String(tenantId), tenantRole);
    const roleIds = await this.resolveBaselineRoleIds(
      String(tenantId),
      inviteUserDto.roleIds,
    );
    // Roles carry permission keys, so attaching them is a grant like any other.
    await this.assertCallerCanGrant(
      String(tenantId),
      await this.expandRoleIdsToKeys(String(tenantId), roleIds),
    );
    const placement = await this.resolvePlacement(
      String(tenantId),
      inviteUserDto,
    );

    // Case 1: User already exists in the system
    const existingUser = await this.usersRepository.findByEmail(
      inviteUserDto.email,
    );

    if (existingUser) {
      const alreadyInTenant = existingUser.tenants?.some(
        (t) => t.tenantId?.toString() === tenantId.toString(),
      );
      if (alreadyInTenant) {
        throw new UnprocessableEntityException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          errors: {
            email: 'userAlreadyInTenant',
          },
        });
      }

      if (existingUser.keycloakId && tenant.keycloakOrgId) {
        try {
          await this.keycloakAdminService.addUserToOrganization(
            tenant.keycloakOrgId,
            existingUser.keycloakId,
          );
        } catch (e) {
          this.logger.warn(
            `Failed to add existing user to KC org: ${(e as Error).message}`,
          );
        }
      }

      const updated = await this.usersRepository.upsertWithTenants(
        existingUser.keycloakId ?? '',
        inviteUserDto.email,
        {},
        [
          {
            tenantId: tenantId,
            roles: [tenantRole],
            roleIds,
            // Carried on the NEW membership, so joining a second workspace can
            // no longer disturb where this person sits in the first.
            orgUnitId: placement.orgUnitId,
            reportsToId: placement.reportsToId,
            joinedAt: new Date(),
          },
        ],
      );
      await this.joinGroups(updated, inviteUserDto.groupIds);
      this.emitUserTenantMembershipUpdated(updated, tenantId);
      return updated;
    }

    // Case 2: User does NOT exist — create in Keycloak + DB
    let keycloakUserCreated = false;
    let keycloakUser: { id: string; email: string };

    try {
      // May exist from another system.
      const existingKcUser = await this.keycloakAdminService.findUserByEmail(
        inviteUserDto.email,
      );

      if (existingKcUser) {
        keycloakUser = existingKcUser;
      } else {
        keycloakUser = await this.keycloakAdminService.createUser(
          inviteUserDto.email,
          `Tmp!${Date.now()}KC`,
          inviteUserDto.email,
        );
        keycloakUserCreated = true;
      }
    } catch (e) {
      throw new UnprocessableEntityException(
        'Failed to create user in Keycloak: ' + (e as Error).message,
      );
    }

    if (tenant.keycloakOrgId) {
      try {
        await this.keycloakAdminService.addUserToOrganization(
          tenant.keycloakOrgId,
          keycloakUser.id,
        );
      } catch (e) {
        this.logger.warn(
          `Failed to add user to KC org: ${(e as Error).message}`,
        );
      }
    }

    if (keycloakUserCreated) {
      try {
        await this.keycloakAdminService.resetPassword(keycloakUser.id);
      } catch (e) {
        this.logger.warn(
          `Failed to send invite email: ${(e as Error).message}`,
        );
      }
    }

    try {
      const created = await this.usersRepository.create({
        firstName: null,
        lastName: null,
        email: inviteUserDto.email,
        provider: AuthProvidersEnum.email,
        keycloakId: keycloakUser.id,
        platformRole: { id: PlatformRoleEnum.USER },
        status: { id: StatusEnum.active },
        tenants: [
          {
            tenantId: tenantId,
            roles: [tenantRole],
            roleIds,
            orgUnitId: placement.orgUnitId,
            reportsToId: placement.reportsToId,
            joinedAt: new Date(),
          },
        ],
      });
      await this.joinGroups(created, inviteUserDto.groupIds);
      this.emitUserTenantMembershipUpdated(created, tenantId);
      return created;
    } catch (error) {
      this.logger.error(
        'Failed to create user in local DB, rolling back...',
        error,
      );
      if (keycloakUserCreated) {
        try {
          await this.keycloakAdminService.deleteUser(keycloakUser.id);
        } catch (rollbackError) {
          this.logger.error(
            'CRITICAL: Failed to rollback Keycloak user creation',
            rollbackError,
          );
        }
      }
      throw error;
    }
  }

  async removeFromTenant(userId: string): Promise<User> {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new UnprocessableEntityException('Tenant context missing');
    }

    const user = await this.usersRepository.findById(userId);
    if (!user) {
      throw new BusinessException(
        USER_ERRORS.NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'User not found',
      );
    }

    const tenant = await this.tenantsRepository.findById(tenantId);

    if (tenant && tenant.ownerId?.toString() === userId.toString()) {
      throw new UnprocessableEntityException(
        'Cannot remove the tenant owner from the tenant',
      );
    }

    const groups = await this.groupRepository.findGroupsByMember(
      tenantId,
      userId,
    );
    for (const group of groups) {
      await this.groupRepository.removeMember(tenantId, group.id, userId);
    }

    const updated = await this.usersRepository.removeTenantMembership(
      userId,
      tenantId,
    );
    this.eventEmitter.emit('user.tenant-membership.updated', {
      tenantId,
      userId,
    });
    // Channels reference users in their support pool; leaving the id behind
    // would keep routing to someone who is no longer in the tenant.
    this.eventEmitter.emit('user.removed-from-tenant', { tenantId, userId });
    // Losing tenant access without a fresh login is an acceptable UX cost for
    // closing the gap: the user just logs in again for whatever tenants they
    // retain, rather than keeping a live session against the tenant they lost.
    try {
      await this.sessionService.deleteAllSessionsForUser(String(userId));
    } catch (err: any) {
      this.logger.warn(
        `Failed to revoke sessions for user ${userId} after tenant removal: ${err.message}`,
      );
    }
    return updated;
  }

  async getUserGroups(userId: string) {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new UnprocessableEntityException('Tenant context missing');
    }

    const user = await this.usersRepository.findById(userId);
    if (!user) {
      throw new BusinessException(
        USER_ERRORS.NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'User not found',
      );
    }

    const belongsToTenant = user.tenants?.some(
      (t) => t.tenantId?.toString() === tenantId.toString(),
    );
    if (!belongsToTenant) {
      throw new UnprocessableEntityException(
        'User does not belong to this tenant',
      );
    }

    return this.groupRepository.findGroupsByMember(tenantId, userId);
  }

  async resetPassword(id: User['id']): Promise<void> {
    const user = await this.usersRepository.findById(id);
    if (!user) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: {
          user: 'userNotFound',
        },
      });
    }

    if (user.provider === AuthProvidersEnum.email && user.keycloakId) {
      try {
        await this.keycloakAdminService.resetPassword(user.keycloakId);
      } catch {
        throw new UnprocessableEntityException(
          'Failed to trigger reset password in Keycloak',
        );
      }
    } else {
      throw new UnprocessableEntityException(
        'User is not managed by Keycloak or missing Keycloak ID',
      );
    }
  }

  async checkEmail(email: string): Promise<{
    exists: boolean;
    user?: { firstName: string | null; lastName: string | null };
  }> {
    const user = await this.usersRepository.findByEmail(email);
    if (user) {
      return {
        exists: true,
        user: { firstName: user.firstName, lastName: user.lastName },
      };
    }
    return { exists: false };
  }

  async createForTenant(dto: {
    email: string;
    firstName: string;
    lastName: string;
    tenantRole?: string;
    roleIds?: string[];
    orgUnitId?: string;
    groupIds?: string[];
    reportsToId?: string;
  }): Promise<User> {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new UnprocessableEntityException('Tenant context missing');
    }

    const tenant = await this.tenantsRepository.findById(tenantId);
    if (!tenant) {
      throw new UnprocessableEntityException('Tenant not found');
    }

    const existingUser = await this.usersRepository.findByEmail(dto.email);
    if (existingUser) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: {
          email: 'emailAlreadyExists',
        },
      });
    }

    const tenantRole = dto.tenantRole ?? 'MEMBER';
    await this.assertCallerCanGrantTenantRole(String(tenantId), tenantRole);
    const roleIds = await this.resolveBaselineRoleIds(
      String(tenantId),
      dto.roleIds,
    );
    await this.assertCallerCanGrant(
      String(tenantId),
      await this.expandRoleIdsToKeys(String(tenantId), roleIds),
    );
    const placement = await this.resolvePlacement(String(tenantId), dto);
    let keycloakUserCreated = false;
    let keycloakUser: { id: string; email: string };

    try {
      const existingKcUser = await this.keycloakAdminService.findUserByEmail(
        dto.email,
      );

      if (existingKcUser) {
        keycloakUser = existingKcUser;
      } else {
        keycloakUser = await this.keycloakAdminService.createUser(
          dto.email,
          `Tmp!${Date.now()}KC`,
          dto.email,
        );
        keycloakUserCreated = true;
      }
    } catch (e) {
      throw new UnprocessableEntityException(
        'Failed to create user in Keycloak: ' + (e as Error).message,
      );
    }

    if (tenant.keycloakOrgId) {
      try {
        await this.keycloakAdminService.addUserToOrganization(
          tenant.keycloakOrgId,
          keycloakUser.id,
        );
      } catch (e) {
        this.logger.warn(
          `Failed to add user to KC org: ${(e as Error).message}`,
        );
      }
    }

    if (keycloakUserCreated) {
      try {
        await this.keycloakAdminService.resetPassword(keycloakUser.id);
      } catch (e) {
        this.logger.warn(
          `Failed to send password reset email: ${(e as Error).message}`,
        );
      }
    }

    try {
      const created = await this.usersRepository.create({
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        provider: AuthProvidersEnum.email,
        keycloakId: keycloakUser.id,
        platformRole: { id: PlatformRoleEnum.USER },
        status: { id: StatusEnum.active },
        tenants: [
          {
            tenantId: tenantId,
            roles: [tenantRole],
            roleIds,
            orgUnitId: placement.orgUnitId,
            reportsToId: placement.reportsToId,
            joinedAt: new Date(),
          },
        ],
      });
      await this.joinGroups(created, dto.groupIds);
      this.emitUserTenantMembershipUpdated(created, tenantId);
      return created;
    } catch (error) {
      this.logger.error(
        'Failed to create user in local DB, rolling back...',
        error,
      );
      if (keycloakUserCreated) {
        try {
          await this.keycloakAdminService.deleteUser(keycloakUser.id);
        } catch (rollbackError) {
          this.logger.error(
            'CRITICAL: Failed to rollback Keycloak user creation',
            rollbackError,
          );
        }
      }
      throw error;
    }
  }

  async updateStatus(id: User['id'], status: Status): Promise<User | null> {
    const user = await this.usersRepository.findById(id);
    if (!user) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: {
          user: 'userNotFound',
        },
      });
    }

    if (user.provider === AuthProvidersEnum.email && user.keycloakId) {
      try {
        const enabled = status.id === StatusEnum.active;
        await this.keycloakAdminService.updateUserStatus(
          user.keycloakId,
          enabled,
        );
      } catch (error) {
        this.logger.error('Failed to update Keycloak status', error);
        throw new UnprocessableEntityException(
          'Failed to update status in Keycloak',
        );
      }
    }

    const updated = await this.usersRepository.update(id, { status });
    if (updated) {
      this.emitUserPermissionsUpdated(updated);
      await this.revokeSessionsOnPrivilegeDowngrade(user, updated);
    }
    return updated;
  }

  // i18n Preferences (User + Tenant cascade)

  private static readonly I18N_SYSTEM_DEFAULTS = {
    locale: 'en',
    timezone: 'UTC',
    dateFormat: 'MM/DD/YYYY',
    currency: 'USD',
  };

  /**
   * Get the resolved i18n settings for the current user.
   * Resolution order: User preferences → Tenant defaults → System defaults.
   */
  async getResolvedI18n(userId: string, tenantId: string) {
    // Resolve user: try internal ID first, fallback to Keycloak ID
    let user: User | null = null;
    if (userId.length === 24) {
      user = await this.usersRepository.findById(userId);
    }

    if (!user) {
      user = await this.usersRepository.findByKeycloakIdAndProvider({
        keycloakId: userId,
        provider: AuthProvidersEnum.email,
      });
    }

    const tenant = await this.tenantsRepository.findById(tenantId);

    const tenantSettings = tenant?.i18nSettings ?? {
      ...UsersService.I18N_SYSTEM_DEFAULTS,
    };
    const userPrefs = user?.i18nPreferences;

    return {
      locale: userPrefs?.locale ?? tenantSettings.locale,
      timezone: userPrefs?.timezone ?? tenantSettings.timezone,
      dateFormat: tenantSettings.dateFormat,
      currency: tenantSettings.currency,
      // Include source info so frontend knows what's inherited vs overridden
      _sources: {
        locale: userPrefs?.locale ? 'user' : 'tenant',
        timezone: userPrefs?.timezone ? 'user' : 'tenant',
        dateFormat: 'tenant',
        currency: 'tenant',
      },
    };
  }

  /**
   * Update the current user's i18n preferences.
   * Set a field to null to inherit from tenant defaults.
   */
  async updateI18nPreferences(
    userId: string,
    preferences: { locale?: string | null; timezone?: string | null },
  ) {
    let user: User | null = null;
    if (userId.length === 24) {
      user = await this.usersRepository.findById(userId);
    }

    if (!user) {
      user = await this.usersRepository.findByKeycloakIdAndProvider({
        keycloakId: userId,
        provider: AuthProvidersEnum.email,
      });
    }

    if (!user) {
      throw new BusinessException(
        USER_ERRORS.NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'User not found',
      );
    }

    const internalId = user.id;

    const updated = await this.usersRepository.update(internalId, {
      i18nPreferences: {
        locale: preferences.locale ?? null,
        timezone: preferences.timezone ?? null,
      },
    });

    return updated?.i18nPreferences ?? null;
  }

  /**
   * Promote/demote a user's tenant role (ADMIN ⇄ MEMBER) in the ACTIVE tenant.
   *
   * Deliberately a dedicated endpoint rather than part of `update()`: the ADMIN
   * flag short-circuits to the whole tenant ceiling in permission.engine.ts, so
   * it must not be settable through the generic membership payload (that path
   * intentionally refuses it to prevent self-escalation).
   */
  async setTenantRole(
    userId: string,
    tenantRole: 'ADMIN' | 'MEMBER',
  ): Promise<User> {
    const activeTenantId = getTenantId(this.cls);
    if (!activeTenantId) {
      throw new UnprocessableEntityException('No active tenant in context');
    }

    const actorId = getUserId(this.cls);
    if (actorId && String(actorId) === String(userId)) {
      throw new UnprocessableEntityException(
        'You cannot change your own tenant role',
      );
    }

    const user = await this.usersRepository.findById(userId);
    if (!user)
      throw new BusinessException(
        USER_ERRORS.NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'User not found',
      );

    const membership = user.tenants?.find(
      (t) => String(t.tenantId) === String(activeTenantId),
    );
    if (!membership) {
      throw new BusinessException(
        USER_ERRORS.NOT_IN_TENANT,
        HttpStatus.NOT_FOUND,
        'User is not a member of this tenant',
      );
    }

    // The owner's access is derived from tenant.ownerId, not from this flag —
    // demoting them here would be a no-op that reads like a security change.
    const tenant = await this.tenantsRepository.findById(activeTenantId);
    if (tenant && String((tenant as any).ownerId ?? '') === String(user.id)) {
      throw new UnprocessableEntityException(
        'The workspace owner always has full access. Transfer ownership instead.',
      );
    }

    const before = [...(membership.roles ?? [])];
    if (before.length === 1 && before[0] === tenantRole) return user;

    const tenants = (user.tenants ?? []).map((m) =>
      String(m.tenantId) === String(activeTenantId)
        ? { ...m, roles: [tenantRole] }
        : m,
    );

    const updated = await this.usersRepository.update(user.id, {
      tenants,
    } as any);
    if (!updated)
      throw new BusinessException(
        USER_ERRORS.NOT_FOUND,
        HttpStatus.NOT_FOUND,
        'User not found',
      );

    void this.audit.record({
      category: 'MEMBERSHIP',
      action: 'assign',
      targetType: 'user',
      targetId: String(user.id),
      summary: `changed tenant role of user ${String(user.id)} to ${tenantRole}`,
      before: { roles: before },
      after: { roles: [tenantRole] },
    });
    this.emitUserTenantMembershipUpdated(updated, activeTenantId);

    return updated;
  }

  private emitUserPermissionsUpdated(user: User): void {
    for (const membership of user.tenants ?? []) {
      this.eventEmitter.emit('user.permissions.updated', {
        tenantId: String(membership.tenantId),
        userId: String(user.id),
      });
    }
  }

  /**
   * Emit a per-tenant profile-update event carrying routing-relevant attributes
   * (skills, omniMaxCapacity). Consumed by AgentPresenceService to keep its
   * Redis presence caches in sync without the omni module reaching into users.
   */
  private emitUserProfileUpdated(
    user: User,
    attrs: { skills?: string[]; omniMaxCapacity?: number | null },
  ): void {
    for (const membership of user.tenants ?? []) {
      this.eventEmitter.emit('user.profile.updated', {
        tenantId: String(membership.tenantId),
        userId: String(user.id),
        skills: attrs.skills,
        omniMaxCapacity: attrs.omniMaxCapacity,
      });
    }
  }

  private emitUserTenantMembershipUpdated(user: User, tenantId: string): void {
    this.eventEmitter.emit('user.tenant-membership.updated', {
      tenantId,
      userId: String(user.id),
    });
  }
}
