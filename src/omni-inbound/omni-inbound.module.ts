import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

// Adapters
import { FacebookAdapter } from './adapters/facebook.adapter';
import { ZaloAdapter } from './adapters/zalo.adapter';
import { WhatsAppAdapter } from './adapters/whatsapp.adapter';
import { InstagramAdapter } from './adapters/instagram.adapter';
import { CHANNEL_ADAPTERS } from './adapters/channel-adapter.interface';
import { ChannelType } from './domain/omni-payload';
import { ChannelAdapter } from './adapters/channel-adapter.interface';

// Processors
import { InboundProcessorService } from './processors/inbound-processor.service';

// Controllers
import { InboundController } from './controllers/inbound.controller';
import { MediaProxyController } from './controllers/media-proxy.controller';
import { OmniController } from './controllers/omni.controller';
import { AgentStatusAuditController } from './controllers/agent-status-audit.controller';

// Services
import { MediaProxyService } from './services/media-proxy.service';
import { AgentPresenceService } from './services/agent-presence.service';
import { AgentPresenceGateway } from './services/agent-presence.gateway';
import { OmniGateway } from './services/omni.gateway';
import { ConversationService } from './services/conversation.service';
import { ConversionService } from './services/conversion.service';
import { OmniOutboundModule } from '../omni-outbound/omni-outbound.module';
import { IdentityService } from './services/identity.service';
import { NoteService } from './services/note.service';
import { AssignmentService } from './services/assignment.service';
import { ActivityService } from './services/activity.service';
import { AgentFallbackService } from './services/agent-fallback.service';
import { AutoResolveService } from './services/auto-resolve.service';
import { BusinessHoursService } from './services/business-hours.service';
import { AgentStatusAuditService } from './services/agent-status-audit.service';
import { ConversationLockService } from './services/conversation-lock.service';

// Queue
import { OmniQueueModule } from './queue/omni-queue.module';
import { WebhookProcessor } from './queue/webhook-processor';
import { OmniRoutingProcessor } from './queue/omni-routing.processor';
import { MediaCacheProcessor } from './queue/media-cache.processor';
import { StickyRetryProcessor } from './queue/sticky-retry.processor';
import { AutoResolveProcessor } from './queue/auto-resolve.processor';
import { BotProcessingProcessor } from './bot/bot-processing.processor';
import { BotApiService } from './bot/bot-api.service';
import { BotQueueService } from './bot/bot-queue.service';
import { BotCallbackController } from './bot/bot-callback.controller';

// Repositories
import { ConversationRepository } from './repositories/conversation.repository';
import { MessageRepository } from './repositories/message.repository';
import { NoteRepository } from './repositories/note.repository';
import { ActivityRepository } from './repositories/activity.repository';
import { AssignmentAuditLogRepository } from './repositories/assignment-audit-log.repository';
import { AgentStatusAuditRepository } from './repositories/agent-status-audit.repository';

// Schemas
import {
  OmniConversationSchemaClass,
  OmniConversationSchema,
} from './infrastructure/persistence/document/entities/omni-conversation.schema';
import {
  OmniMessageSchemaClass,
  OmniMessageSchema,
} from './infrastructure/persistence/document/entities/omni-message.schema';
import {
  OmniNoteSchemaClass,
  OmniNoteSchema,
} from './infrastructure/persistence/document/entities/omni-note.schema';
import {
  ConversationActivitySchemaClass,
  ConversationActivitySchema,
} from './infrastructure/persistence/document/entities/conversation-activity.schema';
import {
  OmniAssignmentAuditLogSchemaClass,
  OmniAssignmentAuditLogSchema,
} from './infrastructure/persistence/document/entities/assignment-audit-log.schema';
import {
  GroupSchemaClass,
  GroupSchema,
} from '../groups/infrastructure/persistence/document/entities/group.schema';
import {
  AgentStatusAuditLogSchemaClass,
  AgentStatusAuditLogSchema,
} from './infrastructure/persistence/document/entities/agent-status-audit-log.schema';

// External modules
import { ChannelsModule } from '../channels/channels.module';
import { RedisModule } from '../redis/redis.module';
import { ContactsModule } from '../contacts/contacts.module';
import { UsersModule } from '../users/users.module';
import { TenantsModule } from '../tenants/tenants.module';
import { AuthModule } from '../auth/auth.module';
import { DealsModule } from '../deals/deals.module';
import { TicketsModule } from '../tickets/tickets.module';
import { RoutingRulesModule } from '../routing-rules/routing-rules.module';
import { FilesModule } from '../files/files.module';
import { isWorkerRuntime, isOmniRuntime } from '../config/runtime-role';

const workerProviders =
  isWorkerRuntime() || isOmniRuntime()
    ? [
        WebhookProcessor,
        OmniRoutingProcessor,
        MediaCacheProcessor,
        StickyRetryProcessor,
        AutoResolveProcessor,
        BotProcessingProcessor,
      ]
    : [];

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
 * 7. Notes                — NoteService, NoteRepository
 * 8. Assignment Engine    — AssignmentService (round-robin, least-busy, sticky wait-time)
 * 9. Audit Trail          — ActivityService, ActivityRepository
 * 10. Agent Disconnect Fallback
 * 11. Session Lifecycle   — AutoResolveService (BullMQ delayed jobs), BusinessHoursService
 */
@Module({
  imports: [
    ChannelsModule,
    RedisModule,
    ContactsModule,
    UsersModule,
    TenantsModule,
    forwardRef(() => AuthModule),
    OmniQueueModule,
    OmniOutboundModule,
    DealsModule,
    TicketsModule,
    RoutingRulesModule,
    FilesModule,
    MongooseModule.forFeature([
      {
        name: OmniConversationSchemaClass.name,
        schema: OmniConversationSchema,
      },
      { name: OmniMessageSchemaClass.name, schema: OmniMessageSchema },
      { name: OmniNoteSchemaClass.name, schema: OmniNoteSchema },
      {
        name: ConversationActivitySchemaClass.name,
        schema: ConversationActivitySchema,
      },
      {
        name: OmniAssignmentAuditLogSchemaClass.name,
        schema: OmniAssignmentAuditLogSchema,
      },
      {
        name: GroupSchemaClass.name,
        schema: GroupSchema,
      },
      {
        name: AgentStatusAuditLogSchemaClass.name,
        schema: AgentStatusAuditLogSchema,
      },
    ]),
  ],
  controllers: [
    InboundController,
    MediaProxyController,
    OmniController,
    AgentStatusAuditController,
    BotCallbackController,
  ],
  providers: [
    // ── Pillar 1: Data Normalization ───────────────────────────────
    FacebookAdapter,
    ZaloAdapter,
    WhatsAppAdapter,
    InstagramAdapter,
    {
      provide: CHANNEL_ADAPTERS,
      useFactory: (
        fb: FacebookAdapter,
        zalo: ZaloAdapter,
        wa: WhatsAppAdapter,
        ig: InstagramAdapter,
      ) => {
        const map = new Map<ChannelType, ChannelAdapter>();
        map.set('facebook', fb);
        map.set('zalo', zalo);
        map.set('whatsapp', wa);
        map.set('instagram', ig);
        return map;
      },
      inject: [FacebookAdapter, ZaloAdapter, WhatsAppAdapter, InstagramAdapter],
    },
    InboundProcessorService,
    MediaProxyService,

    // ── Pillar 2: Agent System ────────────────────────────────────
    AgentPresenceService,
    AgentPresenceGateway,
    ConversationLockService,

    // ── Pillar 3: Realtime UX ─────────────────────────────────────
    OmniGateway,

    // ── Pillar 4: Webhook Queue ─────────────────────────────────────
    ...workerProviders,
    BotQueueService,
    BotApiService,

    // ── Pillar 5: Persistence ─────────────────────────────────────
    ConversationRepository,
    MessageRepository,
    ConversationService,
    ConversionService,
    IdentityService,

    // ── Pillar 7: Notes ───────────────────────────────────────────
    NoteRepository,
    NoteService,

    // ── Pillar 8: Assignment Engine ───────────────────────────────
    AssignmentService,

    // ── Pillar 9: Audit Trail ─────────────────────────────────────
    ActivityRepository,
    ActivityService,
    AssignmentAuditLogRepository,

    // ── Pillar 10: Agent Disconnect Fallback ──────────────────────
    AgentFallbackService,

    // ── Pillar 11: Session Lifecycle (Auto-Resolve + Business Hours) ─
    AutoResolveService,
    BusinessHoursService,

    // ── Pillar 12: Agent Status Audit + Work Time KPI ─────────────
    AgentStatusAuditRepository,
    AgentStatusAuditService,
  ],
  exports: [
    InboundProcessorService,
    MediaProxyService,
    AgentPresenceService,
    ConversationRepository,
    MessageRepository,
    ConversationService,
    OmniOutboundModule,
    IdentityService,
    NoteService,
    AssignmentService,
    ConversionService,
    ActivityService,
    AgentFallbackService,
    AutoResolveService,
    BusinessHoursService,
    AgentStatusAuditService,
    ConversationLockService,
    BotQueueService,
  ],
})
export class OmniInboundModule {}
