import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EventEmitterModule } from '@nestjs/event-emitter';

// Adapters
import { FacebookAdapter } from './adapters/facebook.adapter';
import { ZaloAdapter } from './adapters/zalo.adapter';
import { WhatsAppAdapter } from './adapters/whatsapp.adapter';
import { CHANNEL_ADAPTERS } from './adapters/channel-adapter.interface';
import { ChannelType } from './domain/omni-payload';
import { ChannelAdapter } from './adapters/channel-adapter.interface';

// Processors
import { InboundProcessorService } from './processors/inbound-processor.service';

// Controllers
import { InboundController } from './controllers/inbound.controller';
import { MediaProxyController } from './controllers/media-proxy.controller';
import { OmniController } from './controllers/omni.controller';

// Services
import { MediaProxyService } from './services/media-proxy.service';
import { AgentPresenceService } from './services/agent-presence.service';
import { AgentPresenceGateway } from './services/agent-presence.gateway';
import { OmniGateway } from './services/omni.gateway';
import { ConversationService } from './services/conversation.service';
import { OutboundService } from './services/outbound.service';

// Queue
import { OmniQueueModule } from './queue/omni-queue.module';
import { WebhookProcessor } from './queue/webhook-processor';

// Repositories
import { ConversationRepository } from './repositories/conversation.repository';
import { MessageRepository } from './repositories/message.repository';

// Schemas
import {
  OmniConversationSchemaClass,
  OmniConversationSchema,
} from './infrastructure/persistence/document/entities/omni-conversation.schema';
import {
  OmniMessageSchemaClass,
  OmniMessageSchema,
} from './infrastructure/persistence/document/entities/omni-message.schema';

// External modules
import { ChannelsModule } from '../channels/channels.module';
import { RedisModule } from '../redis/redis.module';

/**
 * OmniInboundModule — the complete omni-channel backend.
 *
 * Pillars:
 * 1. Data Normalization  — adapters, processor, media proxy
 * 2. Agent System         — presence service + gateway
 * 3. Realtime UX          — OmniGateway (Socket.IO)
 * 4. Webhook Queue        — BullMQ for async webhook processing
 * 5. Persistence          — Mongoose schemas, repositories, ConversationService
 * 6. REST API             — OmniController for frontend integration
 */
@Module({
  imports: [
    ChannelsModule,
    RedisModule,
    OmniQueueModule,
    MongooseModule.forFeature([
      { name: OmniConversationSchemaClass.name, schema: OmniConversationSchema },
      { name: OmniMessageSchemaClass.name, schema: OmniMessageSchema },
    ]),
  ],
  controllers: [InboundController, MediaProxyController, OmniController],
  providers: [
    // ── Pillar 1: Data Normalization ───────────────────────────────
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
    InboundProcessorService,
    MediaProxyService,

    // ── Pillar 2: Agent System ────────────────────────────────────
    AgentPresenceService,
    AgentPresenceGateway,

    // ── Pillar 3: Realtime UX ─────────────────────────────────────
    OmniGateway,

    // ── Pillar 4: Webhook Queue ─────────────────────────────────────
    WebhookProcessor,

    // ── Pillar 5: Persistence ─────────────────────────────────────
    ConversationRepository,
    MessageRepository,
    ConversationService,
    OutboundService,
  ],
  exports: [
    InboundProcessorService,
    MediaProxyService,
    AgentPresenceService,
    ConversationRepository,
    MessageRepository,
    ConversationService,
    OutboundService,
  ],
})
export class OmniInboundModule {}
