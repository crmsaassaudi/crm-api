import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { AccountSettingsModule } from '../account-settings/account-settings.module';
import { DealSettingsModule } from '../deal-settings/deal-settings.module';
import { TaskSettingsModule } from '../task-settings/task-settings.module';
import { TicketSettingsModule } from '../ticket-settings/ticket-settings.module';
import {
  GroupSchema,
  GroupSchemaClass,
} from '../groups/infrastructure/persistence/document/entities/group.schema';
import { LayoutSettingsService } from './layout/layout-settings.service';
import { FieldPolicyInterceptor } from './layout/field-policy.interceptor';
import { LayoutAdminController } from './layout/layout-admin.controller';
import { LayoutAdminService } from './layout/layout-admin.service';
import { ObjectConfigController } from './object-config.controller';
import { ObjectConfigService } from './object-config.service';
import { ObjectRegistryService } from './object-registry.service';
import { PrincipalGroupsService } from './principal-groups.service';
import { PicklistProvider } from './picklists/picklist.provider';
import { RecordWriteValidator } from './validation/record-write-validator.service';

/**
 * Owns the description of configurable objects and the enforcement of the
 * tenant's field-level policy.
 *
 * Exported rather than global: the five record modules import it for
 * `FieldPolicyInterceptor` and `LayoutSettingsService`, which makes the dependency
 * visible in each module file. `ObjectRegistryService` holds no state and no
 * connection, so sharing one instance costs nothing.
 *
 * `CrmSettingsModule` is `@Global`, so it is not imported here. The group schema is
 * registered directly instead of importing `GroupsModule` — see
 * `PrincipalGroupsService` for why that edge is worth avoiding.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: GroupSchemaClass.name, schema: GroupSchema },
    ]),
    CustomFieldsModule,
    // The picklist provider reads each object's option set from the store its own
    // runtime validates against, so it depends on those four settings modules.
    AccountSettingsModule,
    DealSettingsModule,
    TaskSettingsModule,
    TicketSettingsModule,
  ],
  controllers: [ObjectConfigController, LayoutAdminController],
  providers: [
    ObjectRegistryService,
    PrincipalGroupsService,
    LayoutSettingsService,
    LayoutAdminService,
    ObjectConfigService,
    PicklistProvider,
    FieldPolicyInterceptor,
    RecordWriteValidator,
  ],
  exports: [
    ObjectRegistryService,
    PrincipalGroupsService,
    LayoutSettingsService,
    FieldPolicyInterceptor,
    RecordWriteValidator,
  ],
})
export class ObjectManagerModule {}
