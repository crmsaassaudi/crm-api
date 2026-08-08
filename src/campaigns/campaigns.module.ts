import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { isCampaignRuntime } from '../config/runtime-role';
import { ContactsModule } from '../contacts/contacts.module';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelAdaptersModule } from '../omni-inbound/adapters/channel-adapters.module';
import {
  ContactSchema,
  ContactSchemaClass,
} from '../contacts/infrastructure/persistence/document/entities/contact.schema';
import {
  ContactIdentitySchema,
  ContactIdentitySchemaClass,
} from '../contacts/identities/contact-identity.schema';
import { CampaignSchema, CampaignSchemaClass } from './campaign.schema';
import {
  CampaignRecipientSchema,
  CampaignRecipientSchemaClass,
} from './campaign-recipient.schema';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { CampaignAudienceService } from './campaign-audience.service';
import { CampaignSendersService } from './campaign-senders.service';
import { CampaignCodeService } from './campaign-code.service';
import { CampaignRunnerService } from './campaign-runner.service';
import { CampaignProducer } from './queue/campaign.producer';
import { CampaignDispatchProcessor } from './queue/campaign-dispatch.processor';
import { CampaignSendProcessor } from './queue/campaign-send.processor';
import { CampaignScheduler } from './queue/campaign.scheduler';
import { CampaignEmailSender } from './senders/email.sender';
import { CampaignSmsSender } from './senders/sms.sender';
import { CampaignWhatsAppSender } from './senders/whatsapp.sender';
import {
  CAMPAIGN_SENDERS,
  CampaignSender,
  CampaignSenderRegistry,
} from './senders/campaign-sender';
import { CampaignChannel } from './domain/campaign-channel';
import {
  CAMPAIGN_DISPATCH_QUEUE,
  CAMPAIGN_SEND_QUEUE,
} from './campaigns.constants';

/**
 * Background work only runs where workers run. The API process still registers
 * the queues — it has to enqueue — but must not consume them, or a request-facing
 * pod would spend its event loop waiting on SMTP.
 *
 * Its own runtime rather than the generic worker pool: a campaign is the one
 * workload whose size a user picks, and 500K contacts materialise to ~5.000 send
 * jobs that would otherwise starve every contact import and CSV export sharing
 * that pool. `all-in-one` still runs everything, so local dev is unchanged.
 */
const workerProviders = isCampaignRuntime()
  ? [CampaignDispatchProcessor, CampaignSendProcessor, CampaignScheduler]
  : [];

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CampaignSchemaClass.name, schema: CampaignSchema },
      {
        name: CampaignRecipientSchemaClass.name,
        schema: CampaignRecipientSchema,
      },
      { name: ContactSchemaClass.name, schema: ContactSchema },
      {
        name: ContactIdentitySchemaClass.name,
        schema: ContactIdentitySchema,
      },
    ]),
    // Audiences are contact segments; the compiler and the segment store both
    // live in ContactsModule, and duplicating either is how two definitions of
    // "who is in this segment" start disagreeing.
    ContactsModule,
    // SMTP/Twilio credentials (TransportPool), the outbound daily-limit counter,
    // and the WhatsApp channel record.
    ChannelsModule,
    // The provider adapters. Shared with the omni inbox rather than re-created,
    // so a channel is added in exactly one place.
    ChannelAdaptersModule,
    BullModule.registerQueue(
      {
        name: CAMPAIGN_DISPATCH_QUEUE,
        defaultJobOptions: {
          // Two attempts, not the usual three: a dispatch that failed twice has
          // a real problem, and each retry re-walks the whole audience.
          attempts: 2,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      },
      {
        name: CAMPAIGN_SEND_QUEUE,
        defaultJobOptions: {
          // Per-recipient failures are recorded in the ledger, never thrown — so
          // a retry here only ever means an infrastructure fault, and it is safe
          // because each recipient is claimed with a compare-and-set.
          attempts: 3,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      },
    ),
    BullBoardModule.forFeature(
      { name: CAMPAIGN_DISPATCH_QUEUE, adapter: BullMQAdapter },
      { name: CAMPAIGN_SEND_QUEUE, adapter: BullMQAdapter },
    ),
  ],
  controllers: [CampaignsController],
  providers: [
    CampaignsService,
    CampaignAudienceService,
    CampaignSendersService,
    CampaignCodeService,
    CampaignRunnerService,
    CampaignProducer,
    CampaignEmailSender,
    CampaignSmsSender,
    CampaignWhatsAppSender,
    {
      provide: CAMPAIGN_SENDERS,
      useFactory: (
        email: CampaignEmailSender,
        sms: CampaignSmsSender,
        whatsapp: CampaignWhatsAppSender,
      ): CampaignSenderRegistry =>
        new Map<CampaignChannel, CampaignSender>([
          [email.channel, email],
          [sms.channel, sms],
          [whatsapp.channel, whatsapp],
        ]),
      inject: [CampaignEmailSender, CampaignSmsSender, CampaignWhatsAppSender],
    },
    ...workerProviders,
  ],
  exports: [CampaignsService],
})
export class CampaignsModule {}
