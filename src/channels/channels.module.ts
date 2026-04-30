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
  KmsCryptoService,
  cryptoServiceFactory,
} from './domain/crypto.service';

// -- Connection Adapters --
import { SendGridAdapter } from './adapters/sendgrid.adapter';
import { TwilioAdapter } from './adapters/twilio.adapter';
import { AdapterRegistryService } from './adapters/adapter-registry.service';

// -- Phase 2: Health Check & Alert --
import { ChannelHealthCheckService } from './channel-health-check.service';
import { ChannelAlertService } from './channel-alert.service';

// -- Phase 3: Transport Pool (LRU cache for decrypted credentials) --
import { TransportPoolService } from './transport-pool.service';

// -- Automation (for delete protection + migration) --
import { AutomationRulesModule } from '../automation-rules/automation-rules.module';

// -- Realtime (for WebSocket alerts) --
import { SocketModule } from '../modules/realtime/socket.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ChannelSchemaClass.name, schema: ChannelSchema },
      { name: ChannelConfigSchemaClass.name, schema: ChannelConfigSchema },
      {
        name: ChannelConfigAuditSchemaClass.name,
        schema: ChannelConfigAuditSchema,
      },
    ]),
    // forwardRef to avoid circular dependency
    forwardRef(() => AutomationRulesModule),
    // Phase 2: WebSocket for real-time alerts
    SocketModule,
  ],
  controllers: [ChannelsController, ChannelConfigController],
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
    AdapterRegistryService,

    // Phase 2: Health Check & Alert
    ChannelHealthCheckService,
    ChannelAlertService,

    // Phase 3: Transport Pool (LRU cache for decrypted credentials)
    TransportPoolService,
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
  ],
})
export class ChannelsModule {}
