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
import { ListViewsService } from './list-views.service';
import { CreateListViewDto, UpdateListViewDto } from './dto/list-view.dto';
import { RequirePermission } from '../common/permissions/permission.decorator';

@ApiTags('List Views')
@ApiBearerAuth()
@Controller({ path: 'list-views', version: '1' })
export class ListViewsController {
  constructor(private readonly service: ListViewsService) {}

  @Get()
  @RequirePermission('view', 'settings')
  @ApiOperation({
    summary: 'Get list views available to the current user for a module',
  })
  getViews(@Query('module') module: string) {
    if (!module) {
      return this.service.getAllViews();
    }
    return this.service.getViewsForUser(module);
  }

  @Get('all')
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({ summary: 'Get all list views (admin)' })
  getAllViews(@Query('module') module?: string) {
    return this.service.getAllViews(module);
  }

  @Get('default')
  @RequirePermission('view', 'settings')
  @ApiOperation({ summary: 'Resolve default view for current user' })
  getDefaultView(@Query('module') module: string) {
    return this.service.getDefaultViewForUser(module);
  }

  @Get('merged')
  @RequirePermission('view', 'settings')
  @ApiOperation({
    summary: 'Get merged view (union of all columns) for current user',
  })
  getMergedView(@Query('module') module: string) {
    return this.service.getMergedViewForUser(module);
  }

  @Get(':id')
  @RequirePermission('view', 'settings')
  @ApiOperation({ summary: 'Get a single list view by ID' })
  getViewById(@Param('id') id: string) {
    return this.service.getViewById(id);
  }

  @Post()
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({ summary: 'Create a new list view' })
  createView(@Body() body: CreateListViewDto) {
    return this.service.createView(body);
  }

  @Patch(':id')
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({ summary: 'Update an existing list view' })
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
