import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SlaPoliciesController } from './sla-policies.controller';
import { SlaPoliciesService } from './sla-policies.service';
import { SlaPolicyRepository } from './infrastructure/persistence/document/repositories/sla-policy.repository';
import {
  SlaPolicySchema,
  SlaPolicySchemaClass,
} from './infrastructure/persistence/document/entities/sla-policy.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SlaPolicySchemaClass.name, schema: SlaPolicySchema },
    ]),
  ],
  controllers: [SlaPoliciesController],
  providers: [SlaPoliciesService, SlaPolicyRepository],
  exports: [SlaPoliciesService],
})
export class SlaPoliciesModule {}
