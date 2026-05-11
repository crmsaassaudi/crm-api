import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';

import { TENANT_PROVISIONING_QUEUE } from './constants/queue.constants';
import { OnboardingController } from './controllers/onboarding.controller';
import { InternalTenantsController } from './controllers/internal-tenants.controller';
import { OnboardingService } from './services/onboarding.service';
import { SampleDataSeederService } from './services/sample-data-seeder.service';
import { TenantProvisioningProducer } from './workers/tenant-provisioning.producer';
import { TenantProvisioningWorker } from './workers/tenant-provisioning.worker';
import { OrphanCleanupCron } from './cron/orphan-cleanup.cron';
import { DocumentTenantPersistenceModule } from './infrastructure/persistence/document/document-persistence.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { RedisModule } from '../redis/redis.module';

// Schema imports for sample data seeder
import {
  ContactSchemaClass,
  ContactSchema,
} from '../contacts/infrastructure/persistence/document/entities/contact.schema';
import {
  AccountSchemaClass,
  AccountSchema,
} from '../accounts/infrastructure/persistence/document/entities/account.schema';
import {
  DealSchemaClass,
  DealSchema,
} from '../deals/infrastructure/persistence/document/entities/deal.schema';
import {
  DealStageSchemaClass,
  DealStageSchema,
} from '../deal-settings/entities/deal-stage.schema';

/**
 * OnboardingModule wires the async tenant provisioning system:
 *
 * - BullMQ queue registration (tenant-provisioning)
 * - Producer: enqueues provisioning jobs
 * - Worker: processes provisioning jobs with saga pattern
 * - Controllers: PLG onboarding + SLG internal APIs
 * - Service: Redis-based onboarding session management
 * - Seeder: Use-case-tailored sample data (Contacts, Accounts, Deals)
 * - Cron: Orphan cleanup for INCOMPLETE_ONBOARDING accounts > 24h
 */
@Module({
  imports: [
    // Register the BullMQ queue
    BullModule.registerQueue({
      name: TENANT_PROVISIONING_QUEUE,
    }),
    // Persistence layer (TenantsRepository, AliasReservationRepository)
    DocumentTenantPersistenceModule,
    // Mongoose models for sample data seeder
    MongooseModule.forFeature([
      { name: ContactSchemaClass.name, schema: ContactSchema },
      { name: AccountSchemaClass.name, schema: AccountSchema },
      { name: DealSchemaClass.name, schema: DealSchema },
      { name: DealStageSchemaClass.name, schema: DealStageSchema },
    ]),
    // AuthModule provides KeycloakAdminService + SessionService
    forwardRef(() => AuthModule),
    // UsersModule provides UserRepository
    forwardRef(() => UsersModule),
    // RedisModule provides RedisService
    RedisModule,
  ],
  controllers: [OnboardingController, InternalTenantsController],
  providers: [
    OnboardingService,
    SampleDataSeederService,
    TenantProvisioningProducer,
    TenantProvisioningWorker,
    OrphanCleanupCron,
  ],
  exports: [
    OnboardingService,
    TenantProvisioningProducer,
    SampleDataSeederService,
  ],
})
export class OnboardingModule {}
