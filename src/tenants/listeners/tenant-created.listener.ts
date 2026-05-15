import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { TenantCreatedEvent } from '../events/tenant-created.event';
import { TenantSettingsSeedingService } from '../../crm-settings/tenant-settings-seeding.service';
import { SampleDataSeederService } from '../services/sample-data-seeder.service';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';

@Injectable()
export class TenantCreatedListener {
  private readonly logger = new Logger(TenantCreatedListener.name);

  constructor(
    private readonly settingsSeeding: TenantSettingsSeedingService,
    private readonly sampleDataSeeder: SampleDataSeederService,
    private readonly cls: ClsService,
  ) {}

  @OnEvent('tenant.created', { async: true })
  async handleTenantCreatedEvent(event: TenantCreatedEvent): Promise<void> {
    return runWithTenantContext(this.cls, event.tenantId, async () => {
      this.logger.log(
        `Tenant created: ${event.companyName} (${event.tenantId}) with admin ${event.adminEmail}`,
      );

      // Seed CRM settings (pipelines, lifecycle stages, etc.)
      await this.settingsSeeding.seedDefaults(event.tenantId);

      // Seed sample data based on onboarding goal (if available)
      if (event.ownerId) {
        await this.sampleDataSeeder.seed(
          event.tenantId,
          event.ownerId,
          event.onboardingGoal,
        );
      }
    });
  }
}
