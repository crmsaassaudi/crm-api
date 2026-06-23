import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

// Adapters
import { FacebookAdapter } from './adapters/facebook.adapter';
import { ZaloAdapter } from './adapters/zalo.adapter';
import { WhatsAppAdapter } from './adapters/whatsapp.adapter';
import { InstagramAdapter } from './adapters/instagram.adapter';
// LivechatAdapter is provided & exported by LivechatModule (F3 fix — single instance)
import { LivechatAdapter } from './adapters/livechat.adapter';
import { TelegramAdapter } from '../channels/telegram/telegram.adapter';
import { TikTokAdapter } from './adapters/tiktok.adapter';
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
import { ReactionService } from './services/reaction.service';
import { InboundOrchestrationService } from './services/inbound-orchestration.service';
import { ShadowContactService } from './services/shadow-contact.service';
import { ConversationLifecycleService } from './services/conversation-lifecycle.service';
import { ConversationQueryService } from './services/conversation-query.service';
import { CrmRealtimeGateway } from './services/crm-realtime.gateway';
import { OmniMetricsListener } from './services/omni-metrics.listener';
import { PresenceReconciliationService } from './services/presence-reconciliation.service';

// Queue
import { OmniQueueModule } from './queue/omni-queue.module';
import { WebhookProcessor } from './queue/webhook-processor';
import { OmniRoutingProcessor } from './queue/omni-routing.processor';
import { MediaCacheProcessor } from './queue/media-cache.processor';
import { StickyRetryProcessor } from './queue/sticky-retry.processor';
import { FallbackReassignProcessor } from './queue/fallback-reassign.processor';
import { AutoResolveProcessor } from './queue/auto-resolve.processor';
import { BotProcessingProcessor } from './bot/bot-processing.processor';
import { BotApiService } from './bot/bot-api.service';
import { BotQueueService } from './bot/bot-queue.service';
import { BotCallbackController } from './bot/bot-callback.controller';
import { InternalChannelsController } from './bot/internal-channels.controller';
import { CsatModule } from './csat/csat.module';

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
import { ObservabilityModule } from '../observability/observability.module';
import { isWorkerRuntime, isOmniRuntime } from '../config/runtime-role';
// F3 fix: import LivechatModule so its LivechatAdapter instance (with gateway wired) is shared
import { LivechatModule } from '../livechat/livechat.module';

const workerProviders =
  isWorkerRuntime() || isOmniRuntime()
    ? [
        WebhookProcessor,
        OmniRoutingProcessor,
        MediaCacheProcessor,
        StickyRetryProcessor,
        FallbackReassignProcessor,
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
    CsatModule,
    ObservabilityModule,
    // F3 fix: LivechatModule provides the single LivechatAdapter instance (gateway-wired)
    forwardRef(() => LivechatModule),
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
    InternalChannelsController,
  ],
  providers: [
    // ── Pillar 1: Data Normalization ───────────────────────────────
    FacebookAdapter,
    ZaloAdapter,
    WhatsAppAdapter,
    InstagramAdapter,
    // LivechatAdapter is NOT listed here — it is provided by LivechatModule (F3 fix)
    // so the same instance that has setGateway() called is registered in CHANNEL_ADAPTERS
    TelegramAdapter,
    TikTokAdapter,
    {
      provide: CHANNEL_ADAPTERS,
      useFactory: (
        fb: FacebookAdapter,
        zalo: ZaloAdapter,
        wa: WhatsAppAdapter,
        ig: InstagramAdapter,
        lc: LivechatAdapter,
        tg: TelegramAdapter,
        tt: TikTokAdapter,
      ) => {
        const map = new Map<ChannelType, ChannelAdapter>();
        map.set('facebook', fb);
        map.set('zalo', zalo);
        map.set('whatsapp', wa);
        map.set('instagram', ig);
        map.set('livechat', lc);
        map.set('telegram', tg);
        map.set('tiktok', tt);
        return map;
      },
      inject: [
        FacebookAdapter,
        ZaloAdapter,
        WhatsAppAdapter,
        InstagramAdapter,
        LivechatAdapter,
        TelegramAdapter,
        TikTokAdapter,
      ],
    },
    InboundProcessorService,
    MediaProxyService,

    // ── Pillar 1b: Reactions (unified across all channels) ─────────
    ReactionService,

    // ── Pillar 2: Agent System ────────────────────────────────────
    AgentPresenceService,
    AgentPresenceGateway,
    ConversationLockService,
    // P0 fix: self-heals Redis presence counters after Redis flush or missed release
    PresenceReconciliationService,

    // ── Pillar 3: Realtime UX ─────────────────────────────────────
    OmniGateway,
    CrmRealtimeGateway,

    // ── Pillar 4: Webhook Queue ─────────────────────────────────────
    ...workerProviders,
    BotQueueService,
    BotApiService,

    // ── Pillar 5: Persistence ─────────────────────────────────────
    ConversationRepository,
    MessageRepository,
    ConversationService,
    ConversationLifecycleService,
    ConversationQueryService,
    InboundOrchestrationService,
    ShadowContactService,
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

    // ── Pillar 13: Observability ────────────────────────────────────
    OmniMetricsListener,
  ],
  exports: [
    InboundProcessorService,
    MediaProxyService,
    AgentPresenceService,
    ConversationRepository,
    MessageRepository,
    ConversationService,
    ConversationQueryService,
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
    ReactionService,
    CsatModule,
  ],
})
export class OmniInboundModule {}
