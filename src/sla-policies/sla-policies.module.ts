import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SlaPoliciesController } from './sla-policies.controller';
import { SlaPoliciesService } from './sla-policies.service';
import { SlaPolicyRepository } from './infrastructure/persistence/document/repositories/sla-policy.repository';
import {
  SlaPolicySchema,
  SlaPolicySchemaClass,
} from './infrastructure/persistence/document/entities/sla-policy.schema';
import { OmniInboundModule } from '../omni-inbound/omni-inbound.module';
import { SlaClockSchema, SlaClockSchemaClass } from './clock/sla-clock.schema';
import { SlaClockService } from './clock/sla-clock.service';

@Module({
  imports: [
    OmniInboundModule,
    MongooseModule.forFeature([
      { name: SlaPolicySchemaClass.name, schema: SlaPolicySchema },
      { name: SlaClockSchemaClass.name, schema: SlaClockSchema },
    ]),
  ],
  controllers: [SlaPoliciesController],
  providers: [SlaPoliciesService, SlaPolicyRepository, SlaClockService],
  exports: [SlaPoliciesService, SlaClockService],
})
export class SlaPoliciesModule {}
