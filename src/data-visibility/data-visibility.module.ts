import { Module, Global } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  UserSchemaClass,
  UserSchema,
} from '../users/infrastructure/persistence/document/entities/user.schema';
import { RoleHierarchyService } from './role-hierarchy.service';
import { DataVisibilityInterceptor } from './data-visibility.interceptor';
import { CrmSettingsModule } from '../crm-settings/crm-settings.module';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserSchemaClass.name, schema: UserSchema },
    ]),
    CrmSettingsModule,
  ],
  providers: [RoleHierarchyService, DataVisibilityInterceptor],
  exports: [RoleHierarchyService, DataVisibilityInterceptor],
})
export class DataVisibilityModule {}
