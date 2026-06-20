import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { LivechatGateway } from './livechat.gateway';
import { LivechatInboundBridge } from './livechat-inbound.bridge';
import { LivechatAdapter } from '../omni-inbound/adapters/livechat.adapter';
import { LivechatEmbedController } from './livechat-embed.controller';
import { LivechatVisitorBridge } from './livechat-visitor.bridge';
import { VisitorUploadService } from './visitor-upload.service';
import { ChannelsModule } from '../channels/channels.module';
import { UsersModule } from '../users/users.module';
import { FilesModule } from '../files/files.module';
import { OmniInboundModule } from '../omni-inbound/omni-inbound.module';

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
    OmniInboundModule, // exports ConversationRepository
    ChannelsModule,
    UsersModule,
    FilesModule, // for LivechatAdapter.sendMedia() + LivechatVisitorBridge (avatar presign)
  ],
  controllers: [LivechatEmbedController],
  providers: [
    LivechatGateway,
    LivechatInboundBridge,
    LivechatAdapter,
    LivechatVisitorBridge,
    VisitorUploadService,
  ],
  exports: [LivechatGateway, LivechatAdapter],
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
