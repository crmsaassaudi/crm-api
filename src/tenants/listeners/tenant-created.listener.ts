import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TenantCreatedEvent } from '../events/tenant-created.event';
import { TenantSettingsSeedingService } from '../../crm-settings/tenant-settings-seeding.service';

@Injectable()
export class TenantCreatedListener {
  private readonly logger = new Logger(TenantCreatedListener.name);

  constructor(private readonly settingsSeeding: TenantSettingsSeedingService) {}

  @OnEvent('tenant.created', { async: true })
  async handleTenantCreatedEvent(event: TenantCreatedEvent): Promise<void> {
    this.logger.log(
      `Tenant created: ${event.companyName} (${event.tenantId}) with admin ${event.adminEmail}`,
    );
    await this.settingsSeeding.seedDefaults(event.tenantId);
  }
}
