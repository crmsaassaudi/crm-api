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
import { SLA_SUBJECT_PORTS } from './clock/sla-subject.port';
import { ConversationSlaPort } from '../omni-inbound/sla/conversation-sla.port';
import { TicketSlaPort } from '../tickets/sla/ticket-sla.port';
import { TicketSlaProjector } from '../tickets/sla/ticket-sla.projector';
import {
  TicketSchema,
  TicketSchemaClass,
} from '../tickets/infrastructure/persistence/document/entities/ticket.schema';

@Module({
  imports: [
    OmniInboundModule,
    MongooseModule.forFeature([
      { name: SlaPolicySchemaClass.name, schema: SlaPolicySchema },
      { name: SlaClockSchemaClass.name, schema: SlaClockSchema },
      { name: TicketSchemaClass.name, schema: TicketSchema },
    ]),
  ],
  controllers: [SlaPoliciesController],
  providers: [
    SlaPoliciesService,
    SlaPolicyRepository,
    SlaClockService,
    // The two subject ports are constructed here rather than exported by their
    // owning modules: TicketsModule importing SlaPoliciesModule (for the
    // projector) while SlaPoliciesModule imported TicketsModule (for the port)
    // is a cycle, and the port needs nothing from TicketsModule but the model.
    ConversationSlaPort,
    TicketSlaPort,
    // Same reason: it listens to ticket events and calls the clock engine, so
    // it needs SlaClockService and nothing from TicketsModule.
    TicketSlaProjector,
    {
      provide: SLA_SUBJECT_PORTS,
      useFactory: (
        conversation: ConversationSlaPort,
        ticket: TicketSlaPort,
      ) => [conversation, ticket],
      inject: [ConversationSlaPort, TicketSlaPort],
    },
  ],
  exports: [SlaPoliciesService, SlaClockService],
})
export class SlaPoliciesModule {}
