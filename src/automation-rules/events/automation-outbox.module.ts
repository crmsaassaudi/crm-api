import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ObservabilityModule } from '../../observability/observability.module';
import {
  AutomationOutboxEventSchema,
  AutomationOutboxEventSchemaClass,
} from '../infrastructure/persistence/document/entities/automation-outbox-event.schema';
import { AutomationQueueModule } from '../queue/automation-queue.module';
import { AutomationTriggerProducer } from '../queue/automation-trigger.producer';
import { AutomationOutboxService } from './automation-outbox.service';

/**
 * Dependency-light durable event boundary shared by CRM write modules.
 * It deliberately does not import AutomationRulesModule, avoiding a cycle
 * between the workflow engine and the aggregate services it can mutate.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: AutomationOutboxEventSchemaClass.name,
        schema: AutomationOutboxEventSchema,
      },
    ]),
    AutomationQueueModule,
    ObservabilityModule,
  ],
  providers: [AutomationTriggerProducer, AutomationOutboxService],
  exports: [AutomationOutboxService],
})
export class AutomationOutboxModule {}
