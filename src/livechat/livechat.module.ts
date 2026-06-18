import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VisitorSession, VisitorSessionSchema } from './visitor-session.schema';
import { VisitorSessionService } from './visitor-session.service';
import { LivechatGateway } from './livechat.gateway';
import { LivechatInboundBridge } from './livechat-inbound.bridge';
import { LivechatAdapter } from '../omni-inbound/adapters/livechat.adapter';
import { LivechatEmbedController } from './livechat-embed.controller';
import { ChannelsModule } from '../channels/channels.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: VisitorSession.name, schema: VisitorSessionSchema },
    ]),
    ChannelsModule,
  ],
  controllers: [LivechatEmbedController],
  providers: [
    VisitorSessionService,
    LivechatGateway,
    LivechatInboundBridge,
    LivechatAdapter,
  ],
  exports: [VisitorSessionService, LivechatGateway, LivechatAdapter],
})
export class LivechatModule {}

