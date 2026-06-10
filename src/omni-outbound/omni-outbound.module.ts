import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

// Service
import { OutboundService } from './outbound.service';

// Config
import replyWindowConfig from './config/reply-window.config';

// Adapters (shared with inbound — imported from omni-inbound)
import { FacebookAdapter } from '../omni-inbound/adapters/facebook.adapter';
import { ZaloAdapter } from '../omni-inbound/adapters/zalo.adapter';
import { WhatsAppAdapter } from '../omni-inbound/adapters/whatsapp.adapter';
import {
  CHANNEL_ADAPTERS,
  ChannelAdapter,
} from '../omni-inbound/adapters/channel-adapter.interface';
import { ChannelType } from '../omni-inbound/domain/omni-payload';

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
    MongooseModule.forFeature([
      {
        name: OmniConversationSchemaClass.name,
        schema: OmniConversationSchema,
      },
      { name: OmniMessageSchemaClass.name, schema: OmniMessageSchema },
      { name: EmailContentSchemaClass.name, schema: EmailContentSchema },
      { name: EmailMetadataSchemaClass.name, schema: EmailMetadataSchema },
    ]),
  ],
  providers: [
    // Adapters
    FacebookAdapter,
    ZaloAdapter,
    WhatsAppAdapter,
    {
      provide: CHANNEL_ADAPTERS,
      useFactory: (
        fb: FacebookAdapter,
        zalo: ZaloAdapter,
        wa: WhatsAppAdapter,
      ) => {
        const map = new Map<ChannelType, ChannelAdapter>();
        map.set('facebook', fb);
        map.set('zalo', zalo);
        map.set('whatsapp', wa);
        return map;
      },
      inject: [FacebookAdapter, ZaloAdapter, WhatsAppAdapter],
    },

    // Repositories
    ConversationRepository,
    MessageRepository,

    // Service
    OutboundService,
  ],
  exports: [OutboundService],
})
export class OmniOutboundModule {}
