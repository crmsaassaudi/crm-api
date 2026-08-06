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
import { DashboardSummaryService } from './dashboard-summary.service';
import { CreateDashboardDto, UpdateDashboardDto } from './dashboard.dto';
import { RequirePermission } from '../common/permissions/permission.decorator';

/**
 * Every route here used to be gated on `contacts:*`, which was wrong in both
 * directions: `contacts:delete` deleted anybody's dashboard, and a user with
 * report access but no contact access could not manage their own.
 *
 * Per-record ownership is enforced in DashboardsService (owner-or-shared to
 * read, owner-only to write), so these decorators gate the capability and the
 * service gates the object — no `@UseAcl` needed on top.
 */
@ApiTags('Dashboards')
@ApiBearerAuth()
@Controller({ path: 'dashboards', version: '1' })
export class DashboardsController {
  constructor(
    private readonly svc: DashboardsService,
    private readonly summary: DashboardSummaryService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List accessible dashboards (own + shared)' })
  @RequirePermission('view', 'dashboards')
  findAll() {
    return this.svc.findAll();
  }

  /**
   * Declared before `:id` — Nest matches routes in declaration order and
   * `summary` would otherwise be read as a dashboard id.
   */
  @Get('summary')
  @ApiOperation({ summary: 'Home dashboard KPIs, aggregated by the database' })
  @RequirePermission('view', 'dashboards')
  getSummary() {
    return this.summary.getSummary();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single dashboard with its layout' })
  @RequirePermission('view', 'dashboards')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new dashboard' })
  @RequirePermission('create', 'dashboards')
  create(@Body() dto: CreateDashboardDto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update dashboard metadata or layout' })
  @RequirePermission('edit', 'dashboards')
  update(@Param('id') id: string, @Body() dto: UpdateDashboardDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a dashboard' })
  @RequirePermission('delete', 'dashboards')
  delete(@Param('id') id: string) {
    return this.svc.delete(id);
  }

  @Post(':id/duplicate')
  @ApiOperation({ summary: 'Duplicate a dashboard to own account' })
  @RequirePermission('create', 'dashboards')
  duplicate(@Param('id') id: string) {
    return this.svc.duplicate(id);
  }
}
