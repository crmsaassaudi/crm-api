import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { CrmSettingsService } from './crm-settings.service';

/**
 * Contact's lifecycle-stage and source picklists, for the caller to render
 * the Contact create/edit form from.
 *
 * Every other object's status/source picklist already comes from
 * `GET /me/object-config` (see `PicklistProvider`), which carries no
 * permission requirement beyond being authenticated. Contact is the one
 * exception: `crm_settings.contact_lifecycle` is genuinely its authority (see
 * `PicklistProvider.contactPicklists`'s own comment), and it groups statuses
 * *by stage* — a shape `/me/object-config`'s flat `ObjectField.options` does
 * not carry, so the client's Stage → Status cascade needs the nested
 * document, not the flattened picklist.
 *
 * `GET /crm-settings/contact_lifecycle` and `contact_source` require
 * `settings:view`, which only Administrator holds by default — so a Sales
 * Rep creating their own contact got empty Stage/Source dropdowns ("Không có
 * tùy chọn"). These two routes return the exact same documents with no
 * permission gate, for the same reason `/me/navigation` and
 * `/me/object-config` carry none: the caller is reading configuration needed
 * to render their own form, not administering the tenant's settings.
 */
@ApiTags('Me')
@ApiBearerAuth()
@Controller({ path: 'me', version: '1' })
export class MeContactSettingsController {
  constructor(
    private readonly settings: CrmSettingsService,
    private readonly cls: ClsService,
  ) {}

  private assertAuthenticated(): void {
    if (!this.cls.get<string>('userId')) {
      throw new UnauthorizedException('Not authenticated');
    }
  }

  @ApiOperation({
    summary: 'Contact lifecycle stages/statuses, grouped, for form rendering.',
    description:
      'Same document as GET /crm-settings/contact_lifecycle, without the settings:view requirement.',
  })
  @Get('contact-lifecycle')
  @HttpCode(HttpStatus.OK)
  async myContactLifecycle() {
    this.assertAuthenticated();
    return this.settings.getSetting('contact_lifecycle');
  }

  @ApiOperation({
    summary: 'Contact source picklist, for form rendering.',
    description:
      'Same document as GET /crm-settings/contact_source, without the settings:view requirement.',
  })
  @Get('contact-source')
  @HttpCode(HttpStatus.OK)
  async myContactSource() {
    this.assertAuthenticated();
    return this.settings.getSetting('contact_source');
  }
}
