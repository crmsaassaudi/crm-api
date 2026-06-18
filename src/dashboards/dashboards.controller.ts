import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { DashboardsService } from './dashboards.service';
import { CreateDashboardDto, UpdateDashboardDto } from './dashboard.dto';
import { RequirePermission } from '../common/permissions/permission.decorator';

@ApiTags('Dashboards')
@ApiBearerAuth()
@Controller({ path: 'dashboards', version: '1' })
export class DashboardsController {
  constructor(private readonly svc: DashboardsService) {}

  @Get()
  @ApiOperation({ summary: 'List accessible dashboards (own + shared)' })
  @RequirePermission('view', 'contacts') // basic authenticated view
  findAll() {
    return this.svc.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single dashboard with its layout' })
  @RequirePermission('view', 'contacts')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new dashboard' })
  @RequirePermission('create', 'contacts')
  create(@Body() dto: CreateDashboardDto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update dashboard metadata or layout' })
  @RequirePermission('edit', 'contacts')
  update(@Param('id') id: string, @Body() dto: UpdateDashboardDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a dashboard' })
  @RequirePermission('delete', 'contacts')
  delete(@Param('id') id: string) {
    return this.svc.delete(id);
  }

  @Post(':id/duplicate')
  @ApiOperation({ summary: 'Duplicate a dashboard to own account' })
  @RequirePermission('create', 'contacts')
  duplicate(@Param('id') id: string) {
    return this.svc.duplicate(id);
  }
}
