import { Logger, Module, OnModuleInit, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LivechatGateway } from './livechat.gateway';
import { LivechatInboundBridge } from './livechat-inbound.bridge';
import { LivechatAdapter } from '../omni-inbound/adapters/livechat.adapter';
import { LivechatEmbedController } from './livechat-embed.controller';
import { LivechatWidgetController } from './livechat-widget.controller';
import { LivechatVisitorBridge } from './livechat-visitor.bridge';
import { VisitorUploadService } from './visitor-upload.service';
import { LivechatWidgetService } from './livechat-widget.service';
import { MessageStatusService } from './services/message-status.service';
import { LivechatWidgetRepository } from './infrastructure/persistence/document/repositories/livechat-widget.repository';
import {
  LivechatWidgetSchemaClass,
  LivechatWidgetSchema,
} from './infrastructure/persistence/document/entities/livechat-widget.schema';
import {
  WidgetEventSchemaClass,
  WidgetEventSchema,
} from './infrastructure/persistence/document/entities/widget-event.schema';
import { WidgetEventRepository } from './infrastructure/persistence/document/repositories/widget-event.repository';
import { LivechatAnalyticsController } from './livechat-analytics.controller';
import { ChannelsModule } from '../channels/channels.module';
import { UsersModule } from '../users/users.module';
import { FilesModule } from '../files/files.module';
import { OmniInboundModule } from '../omni-inbound/omni-inbound.module';
import {
  OmniMessageSchemaClass,
  OmniMessageSchema,
} from '../omni-inbound/infrastructure/persistence/document/entities/omni-message.schema';

/**
 * LivechatModule
 *
 * Livechat là một channel omni như Facebook/WhatsApp/Zalo.
 * Không tạo collection riêng — dùng OmniConversation làm source of truth.
 *
 * Dependency graph:
 *   LivechatGateway       → ConversationRepository (từ OmniInboundModule)
 *   LivechatVisitorBridge → ConversationRepository + UsersService + FilesService (avatar presign)
 *   LivechatAdapter       → FilesService (presigned URL cho media)
 *
 * Wire: LivechatModule.onModuleInit() calls adapter.setGateway(gateway)
 *       để tránh circular DI giữa OmniInboundModule ↔ LivechatModule.
 */
@Module({
  imports: [
    forwardRef(() => OmniInboundModule), // forwardRef to break circular: OmniInbound ↔ Livechat
    MongooseModule.forFeature([
      { name: LivechatWidgetSchemaClass.name, schema: LivechatWidgetSchema },
      { name: WidgetEventSchemaClass.name, schema: WidgetEventSchema },
      { name: OmniMessageSchemaClass.name, schema: OmniMessageSchema },
    ]),
    ChannelsModule,
    UsersModule,
    FilesModule, // for LivechatAdapter.sendMedia() + LivechatVisitorBridge (avatar presign)
  ],
  controllers: [
    LivechatEmbedController,
    LivechatWidgetController,
    LivechatAnalyticsController,
  ],
  providers: [
    LivechatGateway,
    LivechatInboundBridge,
    LivechatAdapter,
    LivechatVisitorBridge,
    VisitorUploadService,
    LivechatWidgetService,
    LivechatWidgetRepository,
    WidgetEventRepository,
    MessageStatusService,
  ],
  exports: [LivechatGateway, LivechatAdapter, LivechatWidgetService],
})
export class LivechatModule implements OnModuleInit {
  private readonly logger = new Logger(LivechatModule.name);

  constructor(
    private readonly adapter: LivechatAdapter,
    private readonly gateway: LivechatGateway,
  ) {}

  /**
   * Wire LivechatGateway into LivechatAdapter after DI is settled.
   * Prevents circular dependency: OmniInboundModule → LivechatAdapter → LivechatGateway → OmniInboundModule
   */
  onModuleInit() {
    this.adapter.setGateway(this.gateway);
    this.logger.log('LivechatGateway wired into LivechatAdapter ✓');
  }
}
