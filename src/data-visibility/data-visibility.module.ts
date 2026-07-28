import { Module, Global } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  UserSchemaClass,
  UserSchema,
} from '../users/infrastructure/persistence/document/entities/user.schema';
import { RoleHierarchyService } from './role-hierarchy.service';
import { DataVisibilityInterceptor } from './data-visibility.interceptor';
import { CrmSettingsModule } from '../crm-settings/crm-settings.module';
import { DataVisibilityCacheInvalidationListener } from './data-visibility-cache-invalidation.listener';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserSchemaClass.name, schema: UserSchema },
    ]),
    CrmSettingsModule,
  ],
  providers: [
    RoleHierarchyService,
    DataVisibilityInterceptor,
    DataVisibilityCacheInvalidationListener,
  ],
  exports: [RoleHierarchyService, DataVisibilityInterceptor],
})
export class DataVisibilityModule {}
