import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

// Adapters
import { FacebookAdapter } from './adapters/facebook.adapter';
import { ZaloAdapter } from './adapters/zalo.adapter';
import { WhatsAppAdapter } from './adapters/whatsapp.adapter';
import { InstagramAdapter } from './adapters/instagram.adapter';
// LivechatAdapter is provided & exported by LivechatModule — one instance only
import { LivechatAdapter } from './adapters/livechat.adapter';
import { TelegramAdapter } from '../channels/telegram/telegram.adapter';
import { TikTokAdapter } from './adapters/tiktok.adapter';
import {
  CHANNEL_ADAPTERS,
  ChannelAdapter,
} from './adapters/channel-adapter.interface';
import { ChannelType } from './domain/omni-payload';

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
// Assignment core adapter — registered with AssignmentCoreService at init
import { ConversationAssignmentAdapter } from './assignment/conversation-assignment.adapter';
import { ConversationCandidatePort } from './assignment/conversation-candidate.port';
import { ConversationLoadPort } from './assignment/conversation-load.port';
import { ConversationCommitPort } from './assignment/conversation-commit.port';
import { ActivityService } from './services/activity.service';
import { AgentFallbackService } from './services/agent-fallback.service';
import { AutoResolveService } from './services/auto-resolve.service';
import { BusinessHoursService } from './services/business-hours.service';
import { AgentStatusAuditService } from './services/agent-status-audit.service';
import { ConversationLockService } from './services/conversation-lock.service';
import { ReactionService } from './services/reaction.service';
import { InboundOrchestrationService } from './services/inbound-orchestration.service';
import { ShadowContactService } from './services/shadow-contact.service';
import { DeliveryReceiptService } from './services/delivery-receipt.service';
import { LifecycleReconcileCron } from './cron/lifecycle-reconcile.cron';
import { ConversationLifecycleService } from './services/conversation-lifecycle.service';
import { ConversationQueryService } from './services/conversation-query.service';
import { CrmRealtimeGateway } from './services/crm-realtime.gateway';
import { OmniMetricsListener } from './services/omni-metrics.listener';
import { OmniReportingProjectionListener } from './services/omni-reporting-projection.listener';
import { PresenceReconciliationService } from './services/presence-reconciliation.service';
import { PresenceSegmentService } from './services/presence-segment.service';
import { WorkStatusService } from './services/work-status.service';
import { PresenceAlertService } from './services/presence-alert.service';
import { PresenceRolloverCron } from './cron/presence-rollover.cron';
import { PresenceAlertCron } from './cron/presence-alert.cron';

// Queue
import { OmniQueueModule } from './queue/omni-queue.module';
import { PresenceSegmentsProcessor } from './queue/presence-segments.processor';
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
import { InternalDirectoryController } from './bot/internal-directory.controller';
import { CsatModule } from './csat/csat.module';

// Repositories
import { ConversationRepository } from './repositories/conversation.repository';
import { ContactVipSyncListener } from './listeners/contact-vip-sync.listener';
import { MessageRepository } from './repositories/message.repository';
import { NoteRepository } from './repositories/note.repository';
import { ActivityRepository } from './repositories/activity.repository';
import { AssignmentAuditLogRepository } from './repositories/omni-assignment-audit-log.repository';
import { AgentStatusAuditRepository } from './repositories/agent-status-audit.repository';
import { AgentStateSegmentRepository } from './repositories/agent-state-segment.repository';
import { InteractionSegmentRepository } from './repositories/interaction-segment.repository';

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
  OmniDailyMetricsSchema,
  OmniDailyMetricsSchemaClass,
} from './infrastructure/persistence/document/entities/omni-daily-metrics.schema';
import {
  OmniNoteSchemaClass,
  OmniNoteSchema,
} from './infrastructure/persistence/document/entities/omni-note.schema';
import {
  ConversationActivitySchemaClass,
  ConversationActivitySchema,
} from './infrastructure/persistence/document/entities/conversation-activity.schema';
import {
  GroupSchemaClass,
  GroupSchema,
} from '../groups/infrastructure/persistence/document/entities/group.schema';
import {
  AgentStatusAuditLogSchemaClass,
  AgentStatusAuditLogSchema,
} from './infrastructure/persistence/document/entities/agent-status-audit-log.schema';
import {
  AgentStateSegmentSchemaClass,
  AgentStateSegmentSchema,
} from './infrastructure/persistence/document/entities/agent-state-segment.schema';
import {
  InteractionSegmentSchemaClass,
  InteractionSegmentSchema,
} from './infrastructure/persistence/document/entities/interaction-segment.schema';

// External modules
import { ChannelsModule } from '../channels/channels.module';
import { RedisModule } from '../redis/redis.module';
import { ContactsModule } from '../contacts/contacts.module';
import { UsersModule } from '../users/users.module';
import { TenantsModule } from '../tenants/tenants.module';
import { AuthModule } from '../auth/auth.module';
import { DealsModule } from '../deals/deals.module';
import { TicketsModule } from '../tickets/tickets.module';
import { FilesModule } from '../files/files.module';
import { ObservabilityModule } from '../observability/observability.module';
import { isOmniRuntime, isWorkerRuntime } from '../config/runtime-role';
// LivechatModule owns the single LivechatAdapter instance (the one wired to the gateway)
import { LivechatModule } from '../livechat/livechat.module';
// Conversation Aggregate — sequential command processing
import { ConversationOpsModule } from './aggregate/conversation-ops.module';
import { ConversationOpsProcessor } from './aggregate/conversation-ops.processor';
import { ModuleRef } from '@nestjs/core';
import { CONVERSATION_OPS_PROCESSOR } from './aggregate/conversation-ops.constants';
import { ConversationCommandService } from './aggregate/conversation-command.service';
import { GroupsModule } from '../groups/groups.module';
import { TagsModule } from '../tags/tags.module';
import {
  QueueEntrySchema,
  QueueEntrySchemaClass,
  WorkItemSchema,
  WorkItemSchemaClass,
  WorkOfferSchema,
  WorkOfferSchemaClass,
} from './work-distribution/work-distribution.schema';
import { WorkDistributionService } from './work-distribution/work-distribution.service';
import { WorkOfferController } from './work-distribution/work-offer.controller';
import {
  ConversationTransferSchema,
  ConversationTransferSchemaClass,
} from './transfer/conversation-transfer.schema';
import { ConversationTransferService } from './transfer/conversation-transfer.service';
import { ConversationTransferController } from './transfer/conversation-transfer.controller';
import {
  InboxSchema,
  InboxSchemaClass,
} from '../inboxes/infrastructure/inbox.schema';

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
        PresenceSegmentsProcessor,
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
    FilesModule,
    CsatModule,
    ObservabilityModule,
    // LivechatModule provides the single, gateway-wired LivechatAdapter instance
    forwardRef(() => LivechatModule),
    // Conversation Aggregate — sequential command processing
    ConversationOpsModule,
    TagsModule,
    GroupsModule,
    MongooseModule.forFeature([
      {
        name: OmniConversationSchemaClass.name,
        schema: OmniConversationSchema,
      },
      { name: OmniMessageSchemaClass.name, schema: OmniMessageSchema },
      {
        name: OmniDailyMetricsSchemaClass.name,
        schema: OmniDailyMetricsSchema,
      },
      { name: OmniNoteSchemaClass.name, schema: OmniNoteSchema },
      {
        name: ConversationActivitySchemaClass.name,
        schema: ConversationActivitySchema,
      },
      {
        name: GroupSchemaClass.name,
        schema: GroupSchema,
      },
      {
        name: AgentStatusAuditLogSchemaClass.name,
        schema: AgentStatusAuditLogSchema,
      },
      {
        name: AgentStateSegmentSchemaClass.name,
        schema: AgentStateSegmentSchema,
      },
      {
        name: InteractionSegmentSchemaClass.name,
        schema: InteractionSegmentSchema,
      },
      { name: WorkItemSchemaClass.name, schema: WorkItemSchema },
      { name: QueueEntrySchemaClass.name, schema: QueueEntrySchema },
      { name: WorkOfferSchemaClass.name, schema: WorkOfferSchema },
      { name: InboxSchemaClass.name, schema: InboxSchema },
      {
        name: ConversationTransferSchemaClass.name,
        schema: ConversationTransferSchema,
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
    InternalDirectoryController,
    WorkOfferController,
    ConversationTransferController,
  ],
  providers: [
    // Data Normalization
    FacebookAdapter,
    ZaloAdapter,
    WhatsAppAdapter,
    InstagramAdapter,
    // LivechatAdapter is NOT listed here — LivechatModule provides it
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

    // Reactions (unified across all channels)
    ReactionService,

    // Agent System
    AgentPresenceService,
    AgentPresenceGateway,
    ConversationLockService,
    // Self-heals Redis presence counters after a Redis flush or a missed release
    PresenceReconciliationService,

    // Realtime UX
    OmniGateway,
    CrmRealtimeGateway,

    // Webhook Queue
    ...workerProviders,
    BotQueueService,
    BotApiService,

    // Persistence
    ConversationRepository,
    MessageRepository,
    ConversationService,
    ConversationLifecycleService,
    ConversationQueryService,
    ContactVipSyncListener,
    InboundOrchestrationService,
    ShadowContactService,
    DeliveryReceiptService,
    LifecycleReconcileCron,
    ConversionService,
    IdentityService,

    // Conversation Aggregate Processor
    // Registered here (not in ConversationOpsModule) so all its deps
    // (ConversationRepository, InboundOrchestrationService, etc.) are
    // available without circular module imports.
    // Note: RedisLockService + IOREDIS_CLIENT come from RedisModule (already imported).
    ConversationCommandService,
    ConversationOpsProcessor,
    // Lets ConversationCommandService reach the processor while keeping its
    // import type-only (a class import closes a runtime require cycle).
    //
    // A thunk, NOT `useExisting`: the processor sits in a DI cycle
    //   processor -> assignment -> work-distribution -> command service -> processor
    // and an alias is resolved eagerly at module init, so Nest would try to
    // resolve the processor while it is still being constructed and wait on a
    // promise that never settles — OmniInboundModule never finishes initialising
    // and the API never listens. Deferring to first use keeps the cycle out of
    // bootstrap entirely (the same trick ConversationOpsProcessor already uses
    // for InboundOrchestrationService via ModuleRef).
    {
      provide: CONVERSATION_OPS_PROCESSOR,
      useFactory: (moduleRef: ModuleRef) => () =>
        moduleRef.get(ConversationOpsProcessor, { strict: false }),
      inject: [ModuleRef],
    },

    // Notes
    NoteRepository,
    NoteService,

    // Assignment
    // The decision pipeline lives in AssignmentModule; these three ports plus
    // the adapter are the conversation-specific half of it.
    ConversationCandidatePort,
    ConversationLoadPort,
    ConversationCommitPort,
    ConversationAssignmentAdapter,
    AssignmentService,

    // Audit Trail
    ActivityRepository,
    ActivityService,
    AssignmentAuditLogRepository,

    // Agent Disconnect Fallback
    AgentFallbackService,

    // Session Lifecycle (Auto-Resolve + Business Hours)
    AutoResolveService,
    BusinessHoursService,

    // Agent Status Audit + Work Time KPI
    AgentStatusAuditRepository,
    AgentStatusAuditService,

    // Presence reporting segments + midnight rollover
    AgentStateSegmentRepository,
    PresenceSegmentService,
    PresenceRolloverCron,

    // Work status (auto-derived) + interaction segments
    InteractionSegmentRepository,
    WorkStatusService,
    WorkDistributionService,
    ConversationTransferService,

    // Presence Alerts (Phase 7)
    PresenceAlertService,
    PresenceAlertCron,

    // Observability
    OmniMetricsListener,
    OmniReportingProjectionListener,
  ],
  exports: [
    InboundProcessorService,
    MediaProxyService,
    AgentPresenceService,
    ConversationRepository,
    MessageRepository,
    ConversationService,
    ConversationQueryService,
    ConversationCommandService,
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
    WorkDistributionService,
    ConversationTransferService,
    CsatModule,
  ],
})
export class OmniInboundModule {}
