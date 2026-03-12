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
import { KeycloakAdminService } from '../auth/services/keycloak-admin.service';
import { InviteUserDto } from './dto/invite-user.dto';
import { PaginationResponseDto } from 'src/utils/dto/pagination-response.dto';
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
          ? [{ tenant: tenantId, roles: [], joinedAt: new Date() }]
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

    let password: string | undefined = undefined;

    if (updateUserDto.password) {
      const userObject = await this.usersRepository.findById(id);

      if (userObject && userObject?.password !== updateUserDto.password) {
        const salt = await bcrypt.genSalt();
        password = await bcrypt.hash(updateUserDto.password, salt);
      }
    }

    let email: string | null | undefined = undefined;

    if (updateUserDto.email) {
      const userObject = await this.usersRepository.findByEmail(
        updateUserDto.email,
      );

      if (userObject && userObject.id !== id) {
        throw new UnprocessableEntityException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          errors: {
            email: 'emailAlreadyExists',
          },
        });
      }

      email = updateUserDto.email;
    } else if (updateUserDto.email === null) {
      email = null;
    }

    let photo: FileType | null | undefined = undefined;

    if (updateUserDto.photo?.id) {
      const fileObject = await this.filesService.findById(
        updateUserDto.photo.id,
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
    } else if (updateUserDto.photo === null) {
      photo = null;
    }

    let platformRole: Role | undefined = undefined;

    if (updateUserDto.platformRole?.id) {
      platformRole = { id: updateUserDto.platformRole.id as PlatformRoleEnum };
    }

    let status: Status | undefined = undefined;

    if (updateUserDto.status?.id) {
      status = { id: updateUserDto.status.id as StatusEnum };
    }

    return this.usersRepository.update(id, {
      // Do not remove comment below.
      // <updating-property-payload />
      firstName: updateUserDto.firstName,
      lastName: updateUserDto.lastName,
      email,
      password,
      photo,
      platformRole,
      status,
      provider: updateUserDto.provider,
      keycloakId: updateUserDto.keycloakId,
      version: updateUserDto.version,
    });
  }

  async remove(id: User['id']): Promise<void> {
    await this.usersRepository.remove(id);
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
        (t) => t.tenant?.toString() === tenantId.toString(),
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
      return this.usersRepository.upsertWithTenants(
        existingUser.keycloakId || '',
        inviteUserDto.email,
        {},
        [{ tenant: tenantId, roles: [tenantRole], joinedAt: new Date() }],
      );
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
      return await this.usersRepository.create({
        firstName: null,
        lastName: null,
        email: inviteUserDto.email,
        provider: AuthProvidersEnum.email,
        keycloakId: keycloakUser.id,
        platformRole: { id: PlatformRoleEnum.USER },
        status: { id: StatusEnum.active },
        tenants: [
          { tenant: tenantId, roles: [tenantRole], joinedAt: new Date() },
        ],
      });
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
    if (tenant && tenant.owner?.toString() === userId.toString()) {
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
    return this.usersRepository.removeTenantMembership(userId, tenantId);
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
      (t) => t.tenant?.toString() === tenantId.toString(),
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
      } catch (error) {
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
      return await this.usersRepository.create({
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        provider: AuthProvidersEnum.email,
        keycloakId: keycloakUser.id,
        platformRole: { id: PlatformRoleEnum.USER },
        status: { id: StatusEnum.active },
        tenants: [
          { tenant: tenantId, roles: [tenantRole], joinedAt: new Date() },
        ],
      });
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
    return this.usersRepository.update(id, { status });
  }
}
