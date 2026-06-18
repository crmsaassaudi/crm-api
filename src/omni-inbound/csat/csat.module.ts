import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  OmniConversationSchemaClass,
  OmniConversationSchema,
} from '../infrastructure/persistence/document/entities/omni-conversation.schema';
import { CsatService } from './csat.service';
import { CsatController } from './csat.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: OmniConversationSchemaClass.name,
        schema: OmniConversationSchema,
      },
    ]),
  ],
  controllers: [CsatController],
  providers: [CsatService],
  exports: [CsatService],
})
export class CsatModule {}
