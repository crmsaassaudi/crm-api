import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  HttpStatus,
  HttpCode,
  SerializeOptions,
  UseInterceptors,
} from '@nestjs/common';
import { CacheTTL } from '@nestjs/cache-manager';
import { HttpCacheInterceptor } from '../common/cache/interceptors/http-cache.interceptor';
import { CacheEntity } from '../common/cache/decorators/cache-entity.decorator';
import { CreateUserDto } from './dto/create-user.dto';
import { InviteUserDto } from './dto/invite-user.dto';
import { CreateUserForTenantDto } from './dto/create-user-for-tenant.dto';
import { CheckEmailDto } from './dto/check-email.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
  ApiOperation,
} from '@nestjs/swagger';
import { Roles } from '../roles/roles.decorator';
import { PlatformRoleEnum } from '../roles/platform-role.enum';

import { NullableType } from '../utils/types/nullable.type';
import { QueryUserDto } from './dto/query-user.dto';
import { User } from './domain/user';
import { UsersService } from './users.service';
import { RolesGuard } from '../roles/roles.guard';
import {
  PaginationResponse,
  PaginationResponseDto,
} from 'src/utils/dto/pagination-response.dto';

@ApiBearerAuth()
@UseGuards(RolesGuard)
@ApiTags('Users')
@Controller({
  path: 'users',
  version: '1',
})
@UseInterceptors(HttpCacheInterceptor)
@CacheEntity('User')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @ApiCreatedResponse({
    type: User,
  })
  @SerializeOptions({
    groups: ['admin'],
  })
  @Roles(PlatformRoleEnum.SUPER_ADMIN)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() createProfileDto: CreateUserDto): Promise<User> {
    return this.usersService.create(createProfileDto);
  }

  @ApiOkResponse({
    description: 'Check if an email already exists in the system',
  })
  @ApiOperation({ summary: 'Check if a user with this email exists' })
  @Post('check-email')
  @HttpCode(HttpStatus.OK)
  checkEmail(@Body() checkEmailDto: CheckEmailDto): Promise<{
    exists: boolean;
    user?: { firstName: string | null; lastName: string | null };
  }> {
    return this.usersService.checkEmail(checkEmailDto.email);
  }

  @ApiCreatedResponse({
    type: User,
  })
  @ApiOperation({ summary: 'Invite an existing user to the current tenant' })
  @SerializeOptions({
    groups: ['admin'],
  })
  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  invite(@Body() inviteUserDto: InviteUserDto): Promise<User> {
    return this.usersService.invite(inviteUserDto);
  }

  @ApiCreatedResponse({
    type: User,
  })
  @ApiOperation({
    summary: 'Create a new user and add them to the current tenant',
  })
  @SerializeOptions({
    groups: ['admin'],
  })
  @Post('create-for-tenant')
  @HttpCode(HttpStatus.CREATED)
  createForTenant(
    @Body() createUserForTenantDto: CreateUserForTenantDto,
  ): Promise<User> {
    return this.usersService.createForTenant(createUserForTenantDto);
  }

  @ApiOkResponse({
    type: PaginationResponse(User),
  })
  @SerializeOptions({
    groups: ['admin'],
  })
  @Get()
  @HttpCode(HttpStatus.OK)
  @CacheTTL(60)
  async findAll(
    @Query() query: QueryUserDto,
  ): Promise<PaginationResponseDto<User>> {
    const page = query?.page ?? 1;
    let limit = query?.limit ?? 10;
    if (limit > 50) {
      limit = 50;
    }

    const tenantId = this.usersService.getTenantId();
    const search = (query as any).search; // Handle search if provided

    // If tenantId is present and user is NOT a super admin, filter by tenant
    // For now, if tenantId is present, we prioritize the tenant-based list for users
    if (tenantId) {
      const users = await this.usersService.findManyByTenant(tenantId);
      // Basic search filtering if needed (or we can update service to handle search)
      let filteredUsers = users;
      if (search) {
        const lowerSearch = search.toLowerCase();
        filteredUsers = users.filter(
          (u) =>
            u.firstName?.toLowerCase().includes(lowerSearch) ||
            u.lastName?.toLowerCase().includes(lowerSearch) ||
            u.email?.toLowerCase().includes(lowerSearch),
        );
      }

      return {
        data: filteredUsers.slice((page - 1) * limit, page * limit),
        totalItems: filteredUsers.length,
        totalPages: Math.ceil(filteredUsers.length / limit),
        currentPage: page,
        hasNextPage: page * limit < filteredUsers.length,
        hasPreviousPage: page > 1,
      };
    }

    return await this.usersService.findManyWithPagination({
      filterOptions: query?.filters,
      sortOptions: query?.sort,
      paginationOptions: {
        page,
        limit,
      },
    });
  }

  @ApiOkResponse({
    type: User,
  })
  @SerializeOptions({
    groups: ['admin'],
  })
  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiParam({
    name: 'id',
    type: String,
    required: true,
  })
  @CacheTTL(60)
  findOne(@Param('id') id: User['id']): Promise<NullableType<User>> {
    return this.usersService.findById(id);
  }

  @ApiOkResponse({ description: 'Groups the user belongs to in this tenant' })
  @ApiOperation({ summary: 'Get all groups a user belongs to in the tenant' })
  @Get(':id/groups')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', type: String, required: true })
  getUserGroups(@Param('id') id: string) {
    return this.usersService.getUserGroups(id);
  }

  @ApiOkResponse({
    type: User,
  })
  @SerializeOptions({
    groups: ['admin'],
  })
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiParam({
    name: 'id',
    type: String,
    required: true,
  })
  update(
    @Param('id') id: User['id'],
    @Body() updateProfileDto: UpdateUserDto,
  ): Promise<User | null> {
    return this.usersService.update(id, updateProfileDto);
  }

  @ApiOperation({ summary: 'Remove a user from the current tenant' })
  @Delete(':id/tenant')
  @ApiParam({ name: 'id', type: String, required: true })
  @HttpCode(HttpStatus.OK)
  removeFromTenant(@Param('id') id: string): Promise<User> {
    return this.usersService.removeFromTenant(id);
  }

  @Delete(':id')
  @ApiParam({
    name: 'id',
    type: String,
    required: true,
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: User['id']): Promise<void> {
    return this.usersService.remove(id);
  }
}
