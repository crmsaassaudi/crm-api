import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import { GroupRepository } from './infrastructure/persistence/document/repositories/group.repository';
import {
  GroupSchema,
  GroupSchemaClass,
} from './infrastructure/persistence/document/entities/group.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: GroupSchemaClass.name, schema: GroupSchema },
    ]),
  ],
  controllers: [GroupsController],
  providers: [GroupsService, GroupRepository],
  exports: [GroupsService],
})
export class GroupsModule {}
