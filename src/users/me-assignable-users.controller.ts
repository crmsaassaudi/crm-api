import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { User } from './domain/user';

interface AssignableUser {
  id: User['id'];
  firstName: string | null;
  lastName: string | null;
  photo?: User['photo'];
}

const MAX_PAGE_SIZE = 50;

/**
 * A minimal directory of the caller's own tenant, for populating an
 * owner/assignee picker — not a settings-administration read.
 *
 * `GET /users` requires `users:view` and serializes with the `admin` group
 * (email, provider, keycloakId included), which is the right shape for the
 * Users administration screen but not for "who can I assign this record to":
 * no built-in role except Manager/Auditor/Administrator grants `users:view`,
 * so a Sales Rep or Support Agent creating their own record got an empty
 * Owner dropdown ("Không có tùy chọn") — including for themselves.
 *
 * This intentionally returns fewer fields than `/users`, not just fewer
 * permission checks: name and photo are enough to render a picker, and a
 * teammate directory of names is not the same sensitivity as the admin user
 * record (email, provider, keycloak id). Any authenticated tenant member may
 * call this; the underlying create/update endpoints still enforce their own
 * `assign`-level permission on whatever ownerId is actually submitted.
 */
@ApiTags('Me')
@ApiBearerAuth()
@Controller({ path: 'me', version: '1' })
export class MeAssignableUsersController {
  constructor(private readonly usersService: UsersService) {}

  @ApiOperation({
    summary: 'Assignable users in the caller’s tenant, for an owner picker.',
    description:
      'Name + photo only — not the admin user record GET /users returns. No users:view requirement.',
  })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @Get('assignable-users')
  @HttpCode(HttpStatus.OK)
  async assignableUsers(
    @Query('search') search?: string,
    @Query('page') pageRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const page = Math.max(1, Number(pageRaw) || 1);
    const limit = Math.min(Number(limitRaw) || 10, MAX_PAGE_SIZE);
    const tenantId = this.usersService.getTenantId();

    const { data, totalItems } = tenantId
      ? await this.usersService.searchByTenant(tenantId, {
          search,
          page,
          limit,
        })
      : { data: [] as User[], totalItems: 0 };

    const minimal: AssignableUser[] = data.map((user) => ({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      photo: user.photo ?? null,
    }));

    return {
      data: minimal,
      totalItems,
      totalPages: Math.ceil(totalItems / limit),
      currentPage: page,
      hasNextPage: page * limit < totalItems,
      hasPreviousPage: page > 1,
    };
  }
}
