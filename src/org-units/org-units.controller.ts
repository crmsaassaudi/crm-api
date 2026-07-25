import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgUnitsService } from './org-units.service';
import {
  CreateOrgUnitDto,
  QueryOrgUnitsDto,
  UpdateOrgUnitDto,
} from './dto/org-unit.dto';
import { RequirePermission } from '../common/permissions';

/**
 * The org tree is the substrate of the ORG_UNIT / ORG_UNIT_SUBTREE data scopes,
 * so writing it is a privilege operation: moving a unit changes who can see
 * which records. Hence `org_units:edit` rather than a generic settings
 * permission, and `view` on reads — the shape of a company's org chart is not
 * public inside the workspace.
 */
@ApiTags('Org Units')
@ApiBearerAuth()
@Controller({ path: 'org-units', version: '1' })
export class OrgUnitsController {
  constructor(private readonly service: OrgUnitsService) {}

  @Get()
  @RequirePermission('view', 'org_units')
  @ApiOperation({ summary: 'List org units (flat, path-ordered)' })
  findAll(@Query() query: QueryOrgUnitsDto) {
    return this.service.findAllScoped(query);
  }

  @Get('tree')
  @RequirePermission('view', 'org_units')
  @ApiOperation({ summary: 'The org unit tree, with per-node member counts' })
  findTree() {
    return this.service.findTreeScoped();
  }

  @Get(':id')
  @RequirePermission('view', 'org_units')
  @ApiOperation({ summary: 'Get a single org unit' })
  findById(@Param('id') id: string) {
    return this.service.findByIdScoped(id);
  }

  @Post()
  @RequirePermission('create', 'org_units')
  @ApiOperation({ summary: 'Create an org unit' })
  create(@Body() dto: CreateOrgUnitDto) {
    return this.service.createScoped(dto);
  }

  @Patch(':id')
  @RequirePermission('edit', 'org_units')
  @ApiOperation({
    summary: 'Update or move an org unit',
    description:
      'Setting parentId moves the unit and rewrites its subtree paths. Cycles and depth-limit violations are rejected.',
  })
  update(@Param('id') id: string, @Body() dto: UpdateOrgUnitDto) {
    return this.service.updateScoped(id, dto);
  }

  @Delete(':id')
  @RequirePermission('delete', 'org_units')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a leaf org unit',
    description:
      'Refused while the unit has child units or member users — reassign them first.',
  })
  remove(@Param('id') id: string) {
    return this.service.removeScoped(id);
  }
}
