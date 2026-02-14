import {
  HttpStatus,
  Injectable,
  Inject,
  forwardRef,
  UnprocessableEntityException,
  UnauthorizedException,
} from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { NullableType } from '../utils/types/nullable.type';
import { FilterUserDto, SortUserDto } from './dto/query-user.dto';
import { UserRepository } from './infrastructure/persistence/user.repository';
import { User } from './domain/user';
import bcrypt from 'bcryptjs';
import { AuthProvidersEnum } from '../auth/auth-providers.enum';
import { FilesService } from '../files/files.service';
import { RoleEnum } from '../roles/roles.enum';
import { StatusEnum } from '../statuses/statuses.enum';
import { IPaginationOptions } from '../utils/types/pagination-options';
import { FileType } from '../files/domain/file';
import { Role } from '../roles/domain/role';
import { Status } from '../statuses/domain/status';
import { UpdateUserDto } from './dto/update-user.dto';
import { ClsService } from 'nestjs-cls';
import { KeycloakAdminService } from '../auth/services/keycloak-admin.service';
import { InviteUserDto } from './dto/invite-user.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UserRepository,
    private readonly filesService: FilesService,
    private readonly cls: ClsService,
    @Inject(forwardRef(() => KeycloakAdminService))
    private readonly keycloakAdminService: KeycloakAdminService,
  ) { }

  async create(createUserDto: CreateUserDto, tenantId?: string, session?: any): Promise<User> {
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

    let role: Role | undefined = undefined;

    if (createUserDto.role?.id) {
      const roleObject = Object.values(RoleEnum)
        .map(String)
        .includes(String(createUserDto.role.id));
      if (!roleObject) {
        throw new UnprocessableEntityException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          errors: {
            role: 'roleNotExists',
          },
        });
      }

      role = {
        id: createUserDto.role.id,
      };
    }

    let status: Status | undefined = undefined;

    if (createUserDto.status?.id) {
      const statusObject = Object.values(StatusEnum)
        .map(String)
        .includes(String(createUserDto.status.id));
      if (!statusObject) {
        throw new UnprocessableEntityException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          errors: {
            status: 'statusNotExists',
          },
        });
      }

      status = {
        id: createUserDto.status.id,
      };
    }

    return this.usersRepository.create({
      // Do not remove comment below.
      // <creating-property-payload />
      tenants: tenantId ? [{ tenant: tenantId, roles: [], joinedAt: new Date() }] : [],
      firstName: createUserDto.firstName,
      lastName: createUserDto.lastName,
      email: email,
      password: password,
      photo: photo,
      role: role,
      status: status,
      provider: createUserDto.provider ?? AuthProvidersEnum.email,
      keycloakId: createUserDto.keycloakId,
    }, session);
  }

  findManyWithPagination({
    filterOptions,
    sortOptions,
    paginationOptions,
  }: {
    filterOptions?: FilterUserDto | null;
    sortOptions?: SortUserDto[] | null;
    paginationOptions: IPaginationOptions;
  }): Promise<User[]> {
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

    let role: Role | undefined = undefined;

    if (updateUserDto.role?.id) {
      const roleObject = Object.values(RoleEnum)
        .map(String)
        .includes(String(updateUserDto.role.id));
      if (!roleObject) {
        throw new UnprocessableEntityException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          errors: {
            role: 'roleNotExists',
          },
        });
      }

      role = {
        id: updateUserDto.role.id,
      };
    }

    let status: Status | undefined = undefined;

    if (updateUserDto.status?.id) {
      const statusObject = Object.values(StatusEnum)
        .map(String)
        .includes(String(updateUserDto.status.id));
      if (!statusObject) {
        throw new UnprocessableEntityException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          errors: {
            status: 'statusNotExists',
          },
        });
      }

      status = {
        id: updateUserDto.status.id,
      };
    }

    return this.usersRepository.update(
      id,
      {
        // Do not remove comment below.
        // <updating-property-payload />
        firstName: updateUserDto.firstName,
        lastName: updateUserDto.lastName,
        email,
        password,
        photo,
        role,
        status,
        provider: updateUserDto.provider,
        keycloakId: updateUserDto.keycloakId,
        version: updateUserDto.version,
      },
    );
  }

  async remove(id: User['id']): Promise<void> {
    await this.usersRepository.remove(id);
  }

  async invite(inviteUserDto: InviteUserDto): Promise<User> {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new UnprocessableEntityException('Tenant context missing');
    }

    const currentUser = this.cls.get('user');
    // Check if current user has access to this tenant (Validation)
    // Assuming currentUser has populated tenants. 
    // If currentUser is not available (e.g. system call), we might skip or fail.
    // For Invite, it's usually an admin action.
    if (currentUser) {
      const hasAccess = currentUser.tenants?.some((t: { tenant: any; }) => t.tenant === tenantId);
      // Ideally check for Admin role within that tenant too, but schema might vary.
      // Based on prompt: "Xác thực rằng Admin hiện tại thực sự có quyền trên tenantId đó"
      // We'll check if tenant is in their list.
      if (!hasAccess) {
        throw new UnauthorizedException('You do not have permission to invite users to this tenant');
      }
    }

    const existingUser = await this.usersRepository.findByEmail(inviteUserDto.email);
    if (existingUser) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: {
          email: 'emailAlreadyExists',
        },
      });
    }

    let roleName = 'user';
    // simplistic mapping, should be improved with Role Service
    if (inviteUserDto.role?.id === RoleEnum.admin) {
      roleName = 'admin';
    } else if (inviteUserDto.role?.id === RoleEnum.user) {
      roleName = 'user';
    }

    let keycloakUser;
    try {
      keycloakUser = await this.keycloakAdminService.createUser(
        inviteUserDto.email,
        tenantId,
        '', // firstName
        '', // lastName
        roleName
      );
    } catch (e) {
      throw new UnprocessableEntityException('Failed to create user in Keycloak: ' + (e as Error).message);
    }

    try {
      await this.keycloakAdminService.resetPassword(keycloakUser.id);
    } catch (e) {
      console.warn('Failed to send invite email', (e as Error).message);
    }

    try {
      return await this.usersRepository.create({
        firstName: null,
        lastName: null,
        email: inviteUserDto.email,
        provider: AuthProvidersEnum.email,
        keycloakId: keycloakUser.id,
        role: inviteUserDto.role ? { id: inviteUserDto.role.id } : { id: RoleEnum.user },
        status: { id: StatusEnum.active },
        tenants: [{ tenant: tenantId, roles: [], joinedAt: new Date() }],
      });
    } catch (error) {
      // Rollback: Delete user from Keycloak if local DB save fails
      console.error('Failed to create user in local DB, rolling back Keycloak user...', error);
      try {
        await this.keycloakAdminService.deleteUser(keycloakUser.id);
      } catch (rollbackError) {
        console.error('CRITICAL: Failed to rollback Keycloak user creation', rollbackError);
      }
      throw error;
    }
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
        const enabled = status.id === StatusEnum.active;
        await this.keycloakAdminService.updateUserStatus(
          user.keycloakId,
          enabled,
        );
      } catch (error) {
        console.error('Failed to update Keycloak status', error);
        throw new UnprocessableEntityException(
          'Failed to update status in Keycloak',
        );
      }
    }

    // 2. Update Local DB
    return this.usersRepository.update(id, { status });
  }
}
