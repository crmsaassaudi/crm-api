import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DealSettingsController } from './deal-settings.controller';
import { DealSettingsService } from './deal-settings.service';
import {
  DealStageSchemaClass,
  DealStageSchema,
} from './entities/deal-stage.schema';
import {
  DealSourceSchemaClass,
  DealSourceSchema,
} from './entities/deal-source.schema';
import {
  PipelineSchemaClass,
  PipelineSchema,
} from './entities/pipeline.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DealStageSchemaClass.name, schema: DealStageSchema },
      { name: DealSourceSchemaClass.name, schema: DealSourceSchema },
      { name: PipelineSchemaClass.name, schema: PipelineSchema },
    ]),
  ],
  controllers: [DealSettingsController],
  providers: [DealSettingsService],
  exports: [DealSettingsService],
})
export class DealSettingsModule {}
