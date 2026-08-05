import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
import replyWindowConfig from './config/reply-window.config';

// Adapters (shared with inbound — imported from omni-inbound)
import { FacebookAdapter } from '../omni-inbound/adapters/facebook.adapter';
import { ZaloAdapter } from '../omni-inbound/adapters/zalo.adapter';
import { WhatsAppAdapter } from '../omni-inbound/adapters/whatsapp.adapter';
import { InstagramAdapter } from '../omni-inbound/adapters/instagram.adapter';
import { LivechatAdapter } from '../omni-inbound/adapters/livechat.adapter';
import {
  CHANNEL_ADAPTERS,
  ChannelAdapter,
} from '../omni-inbound/adapters/channel-adapter.interface';
import { ChannelType } from '../omni-inbound/domain/omni-payload';
import { LivechatModule } from '../livechat/livechat.module';

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
    ConfigModule.forFeature(replyWindowConfig),
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
    forwardRef(() => LivechatModule), // LivechatAdapter (wired with gateway)
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
    // Adapters
    FacebookAdapter,
    ZaloAdapter,
    WhatsAppAdapter,
    InstagramAdapter,
    // LivechatAdapter provided by LivechatModule — same instance with gateway wired
    {
      provide: CHANNEL_ADAPTERS,
      useFactory: (
        fb: FacebookAdapter,
        zalo: ZaloAdapter,
        wa: WhatsAppAdapter,
        ig: InstagramAdapter,
        lc: LivechatAdapter,
      ) => {
        const map = new Map<ChannelType, ChannelAdapter>();
        map.set('facebook', fb);
        map.set('zalo', zalo);
        map.set('whatsapp', wa);
        map.set('instagram', ig);
        map.set('livechat', lc);
        return map;
      },
      inject: [
        FacebookAdapter,
        ZaloAdapter,
        WhatsAppAdapter,
        InstagramAdapter,
        LivechatAdapter,
      ],
    },

    // Repositories
    ConversationRepository,
    MessageRepository,

    // Service + Handlers
    OutboundService,
    OutboundMediaHandler,
    OutboundEmailHandler,
    OutboundReconciliationService,
    DeliveryAttemptService,
    DeliveryCommandService,
    ...(isOmniRuntime() ? [DeliveryProcessor] : []),
  ],
  exports: [OutboundService, DeliveryCommandService],
})
export class OmniOutboundModule {}
