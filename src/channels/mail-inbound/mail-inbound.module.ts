import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { ImapPollerService } from '../services/imap-poller.service';
import { EmailNormalizerService } from '../services/email-normalizer.service';
import { EmailInboundListener } from './email-inbound.listener';

import {
  EmailContentSchema,
  EmailContentSchemaClass,
} from '../infrastructure/persistence/document/entities/email-content.schema';
import {
  EmailMetadataSchema,
  EmailMetadataSchemaClass,
} from '../infrastructure/persistence/document/entities/email-metadata.schema';
import {
  OmniMessageSchema,
  OmniMessageSchemaClass,
} from '../../omni-inbound/infrastructure/persistence/document/entities/omni-message.schema';

import { ChannelsModule } from '../channels.module';
import { RedisModule } from '../../redis/redis.module';
import { CrmSettingsModule } from '../../crm-settings/crm-settings.module';
import { BusinessHoursService } from '../../omni-inbound/services/business-hours.service';

/**
 * MailInboundModule — Email inbound sync engine.
 *
 * Encapsulates:
 *   - ImapPollerService: Scheduled IMAP polling with Redis lock + dynamic intervals
 *   - EmailNormalizerService: Auto-responder filter, bounce detection, thread correlation
 *   - EmailInboundListener: Bridges email events → omni.message.received pipeline
 *   - Email DB schemas: email_contents, email_metadata
 *
 * This module is imported into the app root. It automatically starts polling
 * when SMTP configs with IMAP fields are detected.
 *
 * Dependencies:
 *   - ChannelsModule: for ChannelConfigRepository, CryptoService
 *   - RedisModule: for RedisLockService, RedisService
 *   - CrmSettingsModule: for BusinessHoursService (timezone-aware polling)
 */
@Module({
  imports: [
    forwardRef(() => ChannelsModule),
    RedisModule,
    CrmSettingsModule,
    MongooseModule.forFeature([
      { name: EmailContentSchemaClass.name, schema: EmailContentSchema },
      { name: EmailMetadataSchemaClass.name, schema: EmailMetadataSchema },
      { name: OmniMessageSchemaClass.name, schema: OmniMessageSchema },
    ]),
  ],
  providers: [
    BusinessHoursService,
    EmailNormalizerService,
    EmailInboundListener,
    ImapPollerService,
  ],
  exports: [EmailNormalizerService, EmailInboundListener, ImapPollerService],
})
export class MailInboundModule {}
