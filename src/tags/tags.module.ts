import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';
import { TagRepository } from './infrastructure/persistence/document/repositories/tag.repository';
import { TagUsageService } from './tag-usage.service';
import {
  TagSchema,
  TagSchemaClass,
} from './infrastructure/persistence/document/entities/tag.schema';
import {
  ContactSchema,
  ContactSchemaClass,
} from '../contacts/infrastructure/persistence/document/entities/contact.schema';
import {
  DealSchema,
  DealSchemaClass,
} from '../deals/infrastructure/persistence/document/entities/deal.schema';
import {
  TicketSchema,
  TicketSchemaClass,
} from '../tickets/infrastructure/persistence/document/entities/ticket.schema';
import {
  AccountSchema,
  AccountSchemaClass,
} from '../accounts/infrastructure/persistence/document/entities/account.schema';
import {
  OmniConversationSchema,
  OmniConversationSchemaClass,
} from '../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TagSchemaClass.name, schema: TagSchema },
      { name: ContactSchemaClass.name, schema: ContactSchema },
      { name: DealSchemaClass.name, schema: DealSchema },
      { name: TicketSchemaClass.name, schema: TicketSchema },
      { name: AccountSchemaClass.name, schema: AccountSchema },
      {
        name: OmniConversationSchemaClass.name,
        schema: OmniConversationSchema,
      },
    ]),
  ],
  controllers: [TagsController],
  providers: [TagsService, TagRepository, TagUsageService],
  exports: [TagsService],
})
export class TagsModule {}
