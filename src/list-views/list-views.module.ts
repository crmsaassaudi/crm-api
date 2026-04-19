import { Module, forwardRef } from '@nestjs/common';
import { ListViewsController } from './list-views.controller';
import { ListViewsService } from './list-views.service';
import { GroupsModule } from '../groups/groups.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [GroupsModule, forwardRef(() => UsersModule)],
  controllers: [ListViewsController],
  providers: [ListViewsService],
  exports: [ListViewsService],
})
export class ListViewsModule {}
