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
import {
  ApiTags,
  ApiBearerAuth,
  ApiQuery,
  ApiOperation,
} from '@nestjs/swagger';
import { CustomFieldsService } from './custom-fields.service';
import { CustomField } from './domain/custom-field';
import {
  CreateCustomFieldDto,
  UpdateCustomFieldDto,
} from './dto/custom-field.dto';
import { RequirePermission } from '../common/permissions';

/**
 * Administration of the tenant's custom fields.
 *
 * Read is *not* here for the app to render forms from — that is
 * `GET /me/object-config`, which is self-scoped and needs no settings permission.
 * This controller is the settings surface, so it keeps `settings:*`.
 */
@ApiTags('Custom Fields')
@ApiBearerAuth()
@Controller({
  path: 'custom-fields',
  version: '1',
})
export class CustomFieldsController {
  constructor(private readonly service: CustomFieldsService) {}

  @Get()
  @RequirePermission('view', 'settings')
  @ApiOperation({
    summary: 'Custom fields for the tenant, optionally filtered to one module.',
    description:
      'Administration surface. Clients rendering records should read GET /me/object-config instead, which needs no settings permission and carries the field policy alongside the catalog.',
  })
  @ApiQuery({ name: 'module', required: false })
  getFields(@Query('module') module?: string): Promise<CustomField[]> {
    return module ? this.service.getByModule(module) : this.service.getAll();
  }

  @Post()
  @RequirePermission('manage_system', 'settings')
  @HttpCode(HttpStatus.CREATED)
  createField(@Body() body: CreateCustomFieldDto): Promise<CustomField> {
    return this.service.create(body);
  }

  @Patch(':id')
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({
    summary: 'Update a custom field’s presentation and constraints.',
    description:
      '`internalKey`, `module` and `fieldType` are immutable: every value already stored under the field is keyed by them. Retire the field with `isActive: false` and create a new one instead.',
  })
  updateField(
    @Param('id') id: string,
    @Body() body: UpdateCustomFieldDto,
  ): Promise<CustomField> {
    return this.service.update(id, body);
  }

  @Delete(':id')
  @RequirePermission('manage_system', 'settings')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeField(@Param('id') id: string): Promise<void> {
    return this.service.remove(id);
  }
}
