import { Module, forwardRef } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { DocumentTenantPersistenceModule } from './infrastructure/persistence/document/document-persistence.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { TenantsAuthController } from './tenants.controller';
import { TenantSettingsController } from './tenant-settings.controller';
import { TenantCreatedListener } from './listeners/tenant-created.listener';
import { TenantHealthService } from './tenant-health.service';
import { CrmSettingsModule } from '../crm-settings/crm-settings.module';
import { OnboardingModule } from './onboarding.module';
import { OrgUnitsModule } from '../org-units/org-units.module';
import { GroupsModule } from '../groups/groups.module';
import { DealSettingsModule } from '../deal-settings/deal-settings.module';
import { TicketSettingsModule } from '../ticket-settings/ticket-settings.module';

@Module({
  imports: [
    DocumentTenantPersistenceModule,
    // AuthModule provides KeycloakAdminService
    forwardRef(() => AuthModule),
    // UsersModule provides UserRepository (for upsertWithTenants)
    forwardRef(() => UsersModule),
    // CrmSettingsModule provides TenantSettingsSeedingService
    CrmSettingsModule,
    // The two workflow seeders TenantCreatedListener runs. Both are leaf
    // modules over their own Mongoose models, so importing them here cannot
    // close a cycle — and without the import Nest cannot resolve the listener.
    DealSettingsModule,
    TicketSettingsModule,
    // OnboardingModule provides SampleDataSeederService
    forwardRef(() => OnboardingModule),
    // OrgUnitsModule/GroupsModule provide the default headquarters unit and
    // owner group seeded on tenant.created
    OrgUnitsModule,
    GroupsModule,
  ],
  providers: [TenantsService, TenantCreatedListener, TenantHealthService],
  controllers: [TenantsAuthController, TenantSettingsController],
  exports: [TenantsService, DocumentTenantPersistenceModule],
})
export class TenantsModule {}
