import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';

// -- Existing Channel (Omni-channel inbound) --
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { ChannelRepository } from './infrastructure/persistence/document/repositories/channel.repository';
import {
  ChannelSchema,
  ChannelSchemaClass,
} from './infrastructure/persistence/document/entities/channel.schema';

// -- Channel Config (Outbound sending providers) --
import { ChannelConfigController } from './channel-config.controller';
import { ChannelConfigService } from './channel-config.service';
import { ChannelConfigRepository } from './infrastructure/persistence/document/repositories/channel-config.repository';
import {
  ChannelConfigSchema,
  ChannelConfigSchemaClass,
} from './infrastructure/persistence/document/entities/channel-config.schema';
import {
  EmailContentSchema,
  EmailContentSchemaClass,
} from './infrastructure/persistence/document/entities/email-content.schema';
import { EmailContentController } from './email-content.controller';
import {
  EmailMetadataSchema,
  EmailMetadataSchemaClass,
} from './infrastructure/persistence/document/entities/email-metadata.schema';
import {
  EmailProviderLabelSchema,
  EmailProviderLabelSchemaClass,
} from './infrastructure/persistence/document/entities/email-provider-label.schema';

// -- Channel Config Audit Trail --
import {
  ChannelConfigAuditSchema,
  ChannelConfigAuditSchemaClass,
} from './infrastructure/persistence/document/entities/channel-config-audit.schema';
import { ChannelConfigAuditRepository } from './infrastructure/persistence/document/repositories/channel-config-audit.repository';
import { ChannelConfigAuditService } from './channel-config-audit.service';

// -- Crypto Service (Factory Pattern) --
import {
  CRYPTO_SERVICE_TOKEN,
  EnvCryptoService,
  cryptoServiceFactory,
} from './domain/crypto.service';

// -- Connection Adapters --
import { SendGridAdapter } from './adapters/sendgrid.adapter';
import { TwilioAdapter } from './adapters/twilio.adapter';
import { SmtpAdapter } from './adapters/smtp.adapter';
import { AdapterRegistryService } from './adapters/adapter-registry.service';

// -- Phase 2: Health Check & Alert --
import { ChannelHealthCheckService } from './channel-health-check.service';
import { ChannelAlertService } from './channel-alert.service';

// -- Phase 3: Transport Pool (LRU cache for decrypted credentials) --
import { TransportPoolService } from './transport-pool.service';

// -- Phase 1 Enterprise Email Services --
import { AttachmentSecurityService } from './services/attachment-security.service';
import { OutboundQueueService } from './services/outbound-queue.service';
import {
  EmailSignatureService,
  EmailSignatureSchemaClass,
  EmailSignatureSchema,
} from './services/email-signature.service';
import { EmailNormalizerService } from './services/email-normalizer.service';

// -- Phase 2 Enterprise Email Services --
import { HistoricalSyncService } from './services/historical-sync.service';
import {
  EmailTrackingService,
  EmailTrackingSchemaClass,
  EmailTrackingSchema,
} from './services/email-tracking.service';
import { EmailTrackingController } from './email-tracking.controller';

// -- Phase 4 Enterprise Email Services --
import { EmailChannelSettingsService } from './services/email-channel-settings.service';
import { GdprEmailService } from './services/gdpr-email.service';
import { EmailSettingsController } from './email-settings.controller';
import { EmailIntegrationController } from './email-integration.controller';
import { EmailLabelController } from './email-label.controller';
import { EmailIntegrationService } from './services/email-integration.service';
import { EmailLabelService } from './services/email-label.service';
import { OAuth2TokenManager } from './services/oauth2-token-manager.service';

// -- CRM Settings Module (for EmailChannelSettingsService) --
import { CrmSettingsModule } from '../crm-settings/crm-settings.module';

// -- Automation (for delete protection + migration) --
import { AutomationRulesModule } from '../automation-rules/automation-rules.module';

// -- Realtime (for WebSocket alerts) --
import { SocketModule } from '../modules/realtime/socket.module';
import { isWorkerRuntime, isEmailWorkerRuntime } from '../config/runtime-role';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ChannelSchemaClass.name, schema: ChannelSchema },
      { name: ChannelConfigSchemaClass.name, schema: ChannelConfigSchema },
      {
        name: ChannelConfigAuditSchemaClass.name,
        schema: ChannelConfigAuditSchema,
      },
      // Email-specific storage (Phase 1 — Enterprise Email)
      { name: EmailContentSchemaClass.name, schema: EmailContentSchema },
      { name: EmailMetadataSchemaClass.name, schema: EmailMetadataSchema },
      {
        name: EmailProviderLabelSchemaClass.name,
        schema: EmailProviderLabelSchema,
      },
      { name: EmailSignatureSchemaClass.name, schema: EmailSignatureSchema },
      { name: EmailTrackingSchemaClass.name, schema: EmailTrackingSchema },
    ]),
    // forwardRef to avoid circular dependency
    forwardRef(() => AutomationRulesModule),
    // Phase 2: WebSocket for real-time alerts
    SocketModule,
    // Phase 4: CRM Settings for tenant-level email config
    CrmSettingsModule,
  ],
  controllers: [
    ChannelsController,
    ChannelConfigController,
    EmailContentController,
    EmailTrackingController,
    EmailSettingsController,
    EmailIntegrationController,
    EmailLabelController,
  ],
  providers: [
    // Existing
    ChannelsService,
    ChannelRepository,

    // Channel Config
    ChannelConfigService,
    ChannelConfigRepository,

    // Audit Trail (Phase 4 GA)
    ChannelConfigAuditRepository,
    ChannelConfigAuditService,

    // Crypto Service -- Factory Pattern (env vs kms)
    {
      provide: CRYPTO_SERVICE_TOKEN,
      useFactory: cryptoServiceFactory,
      inject: [ConfigService],
    },
    EnvCryptoService, // Register so NestJS can manage its lifecycle (OnModuleInit)

    // Connection Adapters
    SendGridAdapter,
    TwilioAdapter,
    SmtpAdapter,
    AdapterRegistryService,

    // Phase 2: Health Check & Alert
    ...((isWorkerRuntime() || isEmailWorkerRuntime()) ? [ChannelHealthCheckService] : []),
    ChannelAlertService,

    // Phase 3: Transport Pool (LRU cache for decrypted credentials)
    TransportPoolService,

    // Phase 1 Enterprise Email Services
    AttachmentSecurityService,
    OutboundQueueService,
    EmailSignatureService,
    EmailNormalizerService,

    HistoricalSyncService,
    EmailTrackingService,

    // Phase 4 Enterprise Email Services
    EmailChannelSettingsService,
    GdprEmailService,
    EmailIntegrationService,
    EmailLabelService,
    OAuth2TokenManager,
  ],
  exports: [
    ChannelsService,
    ChannelRepository,
    ChannelConfigService,
    ChannelConfigRepository,
    ChannelConfigAuditRepository,
    AdapterRegistryService,
    CRYPTO_SERVICE_TOKEN,
    TransportPoolService,
    AttachmentSecurityService,
    OutboundQueueService,
    EmailSignatureService,
    EmailChannelSettingsService,
    EmailLabelService,
    OAuth2TokenManager,
  ],
})
export class ChannelsModule {}
