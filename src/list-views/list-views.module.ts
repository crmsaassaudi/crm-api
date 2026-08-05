import { Module } from '@nestjs/common';
import { ListViewsController } from './list-views.controller';
import { ListViewsService } from './list-views.service';
import { AuthorizationModule } from '../common/permissions/authorization.module';
import { ObjectManagerModule } from '../object-manager/object-manager.module';

/**
 * `GroupsModule` and `UsersModule` are gone from here, and with them the
 * `forwardRef` that existed only to break the cycle they created.
 *
 * The service no longer loads the user document to re-derive admin-ness (the
 * authorization engine answers that) and no longer loads every group in the tenant
 * to find the caller's (one indexed query in `PrincipalGroupsService` does).
 */
@Module({
  imports: [AuthorizationModule, ObjectManagerModule],
  controllers: [ListViewsController],
  providers: [ListViewsService],
  exports: [ListViewsService],
})
export class ListViewsModule {}
