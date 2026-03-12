import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';
import { TagRepository } from './infrastructure/persistence/document/repositories/tag.repository';
import {
  TagSchema,
  TagSchemaClass,
} from './infrastructure/persistence/document/entities/tag.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TagSchemaClass.name, schema: TagSchema },
    ]),
  ],
  controllers: [TagsController],
  providers: [TagsService, TagRepository],
  exports: [TagsService],
})
export class TagsModule {}
