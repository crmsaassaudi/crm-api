import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { GroupsService } from './groups.service';
import { CreateGroupDto, QueryGroupDto, UpdateGroupDto } from './dto/group.dto';
import { RequirePermission } from '../common/permissions';

@ApiTags('Groups')
@ApiBearerAuth()
@Controller({ path: 'groups', version: '1' })
export class GroupsController {
  constructor(private readonly service: GroupsService) {}

  @Get()
  @RequirePermission('view', 'groups')
  @ApiOperation({ summary: 'List all groups for the current tenant' })
  findAll(@Query() query: QueryGroupDto) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @RequirePermission('view', 'groups')
  @ApiOperation({ summary: 'Get a single group by id' })
  findById(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post()
  @RequirePermission('create', 'groups')
  @ApiOperation({ summary: 'Create a new group' })
  create(@Body() dto: CreateGroupDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @RequirePermission('edit', 'groups')
  @ApiOperation({ summary: 'Update a group' })
  update(@Param('id') id: string, @Body() dto: UpdateGroupDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('delete', 'groups')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a group' })
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }

  @Post(':id/members/:userId')
  @RequirePermission('manage_members', 'groups')
  @ApiOperation({ summary: 'Add a user to a group' })
  addMember(@Param('id') id: string, @Param('userId') userId: string) {
    return this.service.addMember(id, userId);
  }

  @Delete(':id/members/:userId')
  @RequirePermission('manage_members', 'groups')
  @ApiOperation({ summary: 'Remove a user from a group' })
  removeMember(@Param('id') id: string, @Param('userId') userId: string) {
    return this.service.removeMember(id, userId);
  }
}
