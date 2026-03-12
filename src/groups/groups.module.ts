import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import { GroupRepository } from './infrastructure/persistence/document/repositories/group.repository';
import {
  GroupSchema,
  GroupSchemaClass,
} from './infrastructure/persistence/document/entities/group.schema';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: GroupSchemaClass.name, schema: GroupSchema },
    ]),
    forwardRef(() => UsersModule),
  ],
  controllers: [GroupsController],
  providers: [GroupsService, GroupRepository],
  exports: [GroupsService, GroupRepository],
})
export class GroupsModule {}
