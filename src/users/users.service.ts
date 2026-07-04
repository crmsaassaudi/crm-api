import {
  HttpStatus,
  Injectable,
  Inject,
  forwardRef,
  UnprocessableEntityException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { NullableType } from '../utils/types/nullable.type';
import { FilterUserDto, SortUserDto } from './dto/query-user.dto';
import { UserRepository } from './infrastructure/persistence/user.repository';
import { User } from './domain/user';
import bcrypt from 'bcryptjs';
import { AuthProvidersEnum } from '../auth/auth-providers.enum';
import { FilesService } from '../files/files.service';
import { PlatformRoleEnum } from '../roles/platform-role.enum';
import { StatusEnum } from '../statuses/statuses.enum';
import { IPaginationOptions } from '../utils/types/pagination-options';
import { FileType } from '../files/domain/file';
import { Role } from '../roles/domain/role';
import { Status } from '../statuses/domain/status';
import { UpdateUserDto } from './dto/update-user.dto';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { KeycloakAdminService } from '../auth/services/keycloak-admin.service';
import { InviteUserDto } from './dto/invite-user.dto';
import { PaginationResponseDto } from '../utils/dto/pagination-response.dto';
import { TenantsRepository } from '../tenants/infrastructure/persistence/document/repositories/tenant.repository';
import { GroupRepository } from '../groups/infrastructure/persistence/document/repositories/group.repository';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly usersRepository: UserRepository,
    private readonly filesService: FilesService,
    private readonly cls: ClsService,
    @Inject(forwardRef(() => KeycloakAdminService))
    private readonly keycloakAdminService: KeycloakAdminService,
    private readonly tenantsRepository: TenantsRepository,
    private readonly groupRepository: GroupRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

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

    // ── CRIT-01: Only SUPER_ADMIN may change platformRole or status ──
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
      reportsToId: updateUserDto.reportsToId,
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
    }
    return updated;
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

    // Validate tenant exists
    const tenant = await this.tenantsRepository.findById(tenantId);
    if (!tenant) {
      throw new UnprocessableEntityException('Tenant not found');
    }

    const tenantRole = inviteUserDto.tenantRole || 'MEMBER';

    // ── Case 1: User already exists in the system ───────────────────────────
    const existingUser = await this.usersRepository.findByEmail(
      inviteUserDto.email,
    );

    if (existingUser) {
      // Check if user already belongs to this tenant
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

      // Add user to Keycloak organization (if they have a keycloakId)
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

      // Add tenant membership via upsertWithTenants
      const updated = await this.usersRepository.upsertWithTenants(
        existingUser.keycloakId || '',
        inviteUserDto.email,
        {},
        [{ tenantId: tenantId, roles: [tenantRole], joinedAt: new Date() }],
      );
      this.emitUserTenantMembershipUpdated(updated, tenantId);
      return updated;
    }

    // ── Case 2: User does NOT exist — create in Keycloak + DB ───────────────
    let keycloakUserCreated = false;
    let keycloakUser: { id: string; email: string };

    try {
      // Check if user already exists in Keycloak (may exist from another system)
      const existingKcUser = await this.keycloakAdminService.findUserByEmail(
        inviteUserDto.email,
      );

      if (existingKcUser) {
        keycloakUser = existingKcUser;
      } else {
        // Create new Keycloak user with temporary password
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

    // Add user to Keycloak organization
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

    // Send password reset email for new users
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
          { tenantId: tenantId, roles: [tenantRole], joinedAt: new Date() },
        ],
      });
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Remove user from tenant
  // ─────────────────────────────────────────────────────────────────────────────

  async removeFromTenant(userId: string): Promise<User> {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new UnprocessableEntityException('Tenant context missing');
    }

    const user = await this.usersRepository.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const tenant = await this.tenantsRepository.findById(tenantId);

    // Prevent removing tenant owner
    if (tenant && tenant.ownerId?.toString() === userId.toString()) {
      throw new UnprocessableEntityException(
        'Cannot remove the tenant owner from the tenant',
      );
    }

    // Remove user from all groups in this tenant
    const groups = await this.groupRepository.findGroupsByMember(
      tenantId,
      userId,
    );
    for (const group of groups) {
      await this.groupRepository.removeMember(tenantId, group.id, userId);
    }

    // Remove tenant membership
    const updated = await this.usersRepository.removeTenantMembership(
      userId,
      tenantId,
    );
    this.eventEmitter.emit('user.tenant-membership.updated', {
      tenantId,
      userId,
    });
    return updated;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Get all groups a user belongs to within the current tenant
  // ─────────────────────────────────────────────────────────────────────────────

  async getUserGroups(userId: string) {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new UnprocessableEntityException('Tenant context missing');
    }

    // Verify user belongs to tenant
    const user = await this.usersRepository.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Check if email exists in system (global lookup)
  // ─────────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────────
  // Create a new user within the current tenant context
  // ─────────────────────────────────────────────────────────────────────────────

  async createForTenant(dto: {
    email: string;
    firstName: string;
    lastName: string;
    tenantRole?: string;
  }): Promise<User> {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new UnprocessableEntityException('Tenant context missing');
    }

    const tenant = await this.tenantsRepository.findById(tenantId);
    if (!tenant) {
      throw new UnprocessableEntityException('Tenant not found');
    }

    // Reject if user already exists in the system
    const existingUser = await this.usersRepository.findByEmail(dto.email);
    if (existingUser) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: {
          email: 'emailAlreadyExists',
        },
      });
    }

    const tenantRole = dto.tenantRole || 'MEMBER';
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

    // Add to Keycloak organization
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

    // Send password reset email
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
          { tenantId: tenantId, roles: [tenantRole], joinedAt: new Date() },
        ],
      });
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

    // 1. Update Keycloak if applicable
    if (user.provider === AuthProvidersEnum.email && user.keycloakId) {
      try {
        const enabled = status.id === StatusEnum.active; // 'active' === 'active'
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

    // 2. Update Local DB
    const updated = await this.usersRepository.update(id, { status });
    if (updated) this.emitUserPermissionsUpdated(updated);
    return updated;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // i18n Preferences (User + Tenant cascade)
  // ─────────────────────────────────────────────────────────────────────────────

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
      throw new NotFoundException('User not found');
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
