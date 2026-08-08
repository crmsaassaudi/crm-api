import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
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
  @ApiQuery({
    name: 'ids',
    required: false,
    description:
      'Comma-separated user ids. When present, returns exactly those users (tenant-scoped) instead of a search page — for resolving names of ids a picker already holds (a restored filter, a saved view) without a users:view-gated lookup.',
  })
  @Get('assignable-users')
  @HttpCode(HttpStatus.OK)
  async assignableUsers(
    @Query('search') search?: string,
    @Query('page') pageRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('ids') idsRaw?: string,
  ) {
    const page = Math.max(1, Number(pageRaw) || 1);
    const limit = Math.min(Number(limitRaw) || 10, MAX_PAGE_SIZE);
    const tenantId = this.usersService.getTenantId();
    const ids = idsRaw
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    const { data, totalItems } = await this.resolveUsers(tenantId, {
      search,
      page,
      limit,
      ids,
    });

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

  /**
   * `ids` takes priority over `search`: a caller resolving names for ids it
   * already holds (a restored filter, a saved view) wants exactly those
   * users, not a search page that happens to contain them.
   */
  private async resolveUsers(
    tenantId: string | undefined,
    params: { search?: string; page: number; limit: number; ids?: string[] },
  ): Promise<{ data: User[]; totalItems: number }> {
    if (!tenantId) return { data: [], totalItems: 0 };
    if (params.ids?.length) {
      const data = await this.usersService.findByIds(params.ids);
      return { data, totalItems: data.length };
    }
    return this.usersService.searchByTenant(tenantId, {
      search: params.search,
      page: params.page,
      limit: params.limit,
    });
  }
}
