import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';

// Service
import { OutboundService } from './outbound.service';
import { OutboundMediaHandler } from './outbound-media.handler';
import { OutboundEmailHandler } from './outbound-email.handler';
import { OutboundReconciliationService } from './outbound-reconciliation.service';
import { DeliveryAttemptService } from './delivery-attempt.service';
import { DeliveryCommandService } from './delivery-command.service';
import { DeliveryProcessor } from './delivery.processor';
import { OMNI_DELIVERY_QUEUE } from './delivery-command.constants';
import {
  DeliveryAttemptSchema,
  DeliveryAttemptSchemaClass,
} from './infrastructure/delivery-attempt.schema';
import {
  DeliveryCommandSchema,
  DeliveryCommandSchemaClass,
} from './infrastructure/delivery-command.schema';
import { isOmniRuntime } from '../config/runtime-role';

// Config

// The shared adapter registry — see ChannelAdaptersModule for why it is its own
// module rather than a second copy of the map.
import { ChannelAdaptersModule } from '../omni-inbound/adapters/channel-adapters.module';
import { SystemReplyListener } from './system-reply.listener';

// Repositories (from omni-inbound — need to be imported via OmniInboundModule)
import { ConversationRepository } from '../omni-inbound/repositories/conversation.repository';
import { MessageRepository } from '../omni-inbound/repositories/message.repository';

// Schemas (needed by repositories)
import {
  OmniConversationSchemaClass,
  OmniConversationSchema,
} from '../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';
import {
  OmniMessageSchemaClass,
  OmniMessageSchema,
} from '../omni-inbound/infrastructure/persistence/document/entities/omni-message.schema';

// External modules
import { ChannelsModule } from '../channels/channels.module';
import { UsersModule } from '../users/users.module';
import { FilesModule } from '../files/files.module';
import { ObservabilityModule } from '../observability/observability.module';
import { SsrfGuardModule } from '../common/http/ssrf-guard.module';

// Email schemas
import {
  EmailContentSchemaClass,
  EmailContentSchema,
} from '../channels/infrastructure/persistence/document/entities/email-content.schema';
import {
  EmailMetadataSchemaClass,
  EmailMetadataSchema,
} from '../channels/infrastructure/persistence/document/entities/email-metadata.schema';

/**
 * OmniOutboundModule — independent module for all outbound message operations.
 *
 * Separated from OmniInboundModule so that high-volume outbound campaigns
 * (Broadcast Marketing) do not block or degrade inbound webhook processing.
 */
@Module({
  imports: [
    ChannelsModule,
    UsersModule,
    FilesModule,
    ObservabilityModule,
    SsrfGuardModule,
    BullModule.registerQueue({
      name: OMNI_DELIVERY_QUEUE,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 1_000, age: 86_400 },
        removeOnFail: { count: 5_000, age: 604_800 },
      },
    }),
    // The single adapter registry. Both inbound and outbound read it, which is
    // what stops the two from disagreeing about which channels exist.
    ChannelAdaptersModule,
    MongooseModule.forFeature([
      {
        name: OmniConversationSchemaClass.name,
        schema: OmniConversationSchema,
      },
      { name: OmniMessageSchemaClass.name, schema: OmniMessageSchema },
      {
        name: DeliveryAttemptSchemaClass.name,
        schema: DeliveryAttemptSchema,
      },
      {
        name: DeliveryCommandSchemaClass.name,
        schema: DeliveryCommandSchema,
      },
      { name: EmailContentSchemaClass.name, schema: EmailContentSchema },
      { name: EmailMetadataSchemaClass.name, schema: EmailMetadataSchema },
    ]),
  ],
  providers: [
    // Repositories
    ConversationRepository,
    MessageRepository,

    // Service + Handlers
    OutboundService,
    OutboundMediaHandler,
    OutboundEmailHandler,
    OutboundReconciliationService,
    // Out-of-office replies and auto-resolve warnings — the automated messages the
    // platform sends with no agent behind them.
    SystemReplyListener,
    DeliveryAttemptService,
    DeliveryCommandService,
    ...(isOmniRuntime() ? [DeliveryProcessor] : []),
  ],
  exports: [OutboundService, DeliveryCommandService],
})
export class OmniOutboundModule {}
