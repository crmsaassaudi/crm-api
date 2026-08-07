import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CustomFieldsService } from './custom-fields.service';
import { CustomField } from './domain/custom-field';

/**
 * The tenant's custom fields, for the caller to render a create/edit form
 * from — the same documents `GET /custom-fields` returns, without the
 * `settings:view` requirement that endpoint carries for its administration
 * use case.
 *
 * `GET /me/object-config` already folds custom fields into its per-object
 * field catalog, but only the identity/policy shape (`ObjectField`) needed
 * for layout and masking — it does not carry the presentation metadata
 * (`fieldType`, `section`, `orderIndex`, `validation`, `placeholder`) that
 * `CustomFieldsForm` renders from. Re-deriving that here would risk the same
 * split-brain `/me/object-config` itself was built to close, so this returns
 * the authoritative `CustomField` document unchanged instead of a second,
 * thinner shape.
 */
@ApiTags('Me')
@ApiBearerAuth()
@Controller({ path: 'me', version: '1' })
export class MeCustomFieldsController {
  constructor(private readonly service: CustomFieldsService) {}

  @ApiOperation({
    summary: 'Custom fields for the tenant, for form rendering.',
    description:
      'Same documents as GET /custom-fields, without the settings:view requirement.',
  })
  @ApiQuery({ name: 'module', required: false })
  @Get('custom-fields')
  getFields(@Query('module') module?: string): Promise<CustomField[]> {
    return module ? this.service.getByModule(module) : this.service.getAll();
  }
}
