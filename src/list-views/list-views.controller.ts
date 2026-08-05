import {
  BadRequestException,
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
import { ListViewsService } from './list-views.service';
import { CreateListViewDto, UpdateListViewDto } from './dto/list-view.dto';
import { RequirePermission } from '../common/permissions/permission.decorator';

/**
 * Column layouts, per group.
 *
 * The reads carry no settings permission because each is already scoped to the
 * caller: `getViewsForUser` returns the system defaults plus the views assigned to
 * groups the caller belongs to, and nothing else. They used to require
 * `settings:view`, which no built-in role but Administrator grants, so every list
 * page 403'd for an ordinary member and the client rendered every column instead of
 * the configured ones.
 *
 * Writes, and the unfiltered admin read, keep `settings:manage_system`.
 */
@ApiTags('List Views')
@ApiBearerAuth()
@Controller({ path: 'list-views', version: '1' })
export class ListViewsController {
  constructor(private readonly service: ListViewsService) {}

  @Get()
  @ApiOperation({
    summary: 'List views available to the current caller for one module.',
    description:
      'Self-scoped: system defaults plus views assigned to the caller’s groups. `module` is required — use GET /list-views/all for the unfiltered administrative list.',
  })
  getViews(@Query('module') module: string) {
    // Previously an omitted `module` fell through to `getAllViews()`, returning
    // every view in the tenant from an endpoint whose contract is "mine". Requiring
    // the parameter keeps the two audiences on two routes.
    if (!module) {
      throw new BadRequestException(
        'module is required. Use GET /list-views/all for every view in the tenant.',
      );
    }
    return this.service.getViewsForUser(module);
  }

  @Get('all')
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({ summary: 'Every list view in the tenant (administrative).' })
  getAllViews(@Query('module') module?: string) {
    return this.service.getAllViews(module);
  }

  @Get('default')
  @ApiOperation({ summary: 'The caller’s default view for one module.' })
  getDefaultView(@Query('module') module: string) {
    if (!module) throw new BadRequestException('module is required');
    return this.service.getDefaultViewForUser(module);
  }

  @Get('merged')
  @ApiOperation({
    summary: 'Union of the columns of every view available to the caller.',
  })
  getMergedView(@Query('module') module: string) {
    if (!module) throw new BadRequestException('module is required');
    return this.service.getMergedViewForUser(module);
  }

  @Get(':id')
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({
    summary: 'One list view by id (administrative).',
    description:
      'Administrative: a view id is not scoped to the caller, so reading one by id would let any member enumerate another group’s column configuration.',
  })
  getViewById(@Param('id') id: string) {
    return this.service.getViewById(id);
  }

  @Post()
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({ summary: 'Create a list view' })
  createView(@Body() body: CreateListViewDto) {
    return this.service.createView(body);
  }

  @Patch(':id')
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({ summary: 'Update a list view' })
  updateView(@Param('id') id: string, @Body() body: UpdateListViewDto) {
    return this.service.updateView(id, body);
  }

  @Delete(':id')
  @RequirePermission('manage_system', 'settings')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a list view' })
  deleteView(@Param('id') id: string) {
    return this.service.deleteView(id);
  }
}
