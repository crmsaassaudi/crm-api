import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ContactSchemaClass } from '../contacts/infrastructure/persistence/document/entities/contact.schema';
import { DealSchemaClass } from '../deals/infrastructure/persistence/document/entities/deal.schema';
import { TicketSchemaClass } from '../tickets/infrastructure/persistence/document/entities/ticket.schema';
import { AccountSchemaClass } from '../accounts/infrastructure/persistence/document/entities/account.schema';
import { OmniConversationSchemaClass } from '../omni-inbound/infrastructure/persistence/document/entities/omni-conversation.schema';

/**
 * Tags are referenced by id inside each object's `tags: string[]` array
 * (no Mongo-level FK). This service is the single place that knows how to
 * count/reassign/remove those references per scope, since there's no
 * `TaskSchemaClass` model backing the 'Task' scope yet.
 */
@Injectable()
export class TagUsageService {
  constructor(
    @InjectModel(ContactSchemaClass.name)
    private readonly contactModel: Model<ContactSchemaClass>,
    @InjectModel(DealSchemaClass.name)
    private readonly dealModel: Model<DealSchemaClass>,
    @InjectModel(TicketSchemaClass.name)
    private readonly ticketModel: Model<TicketSchemaClass>,
    @InjectModel(AccountSchemaClass.name)
    private readonly accountModel: Model<AccountSchemaClass>,
    @InjectModel(OmniConversationSchemaClass.name)
    private readonly conversationModel: Model<OmniConversationSchemaClass>,
  ) {}

  private modelForScope(scope: string): Model<any> | null {
    switch (scope) {
      case 'Contact':
        return this.contactModel;
      case 'Deal':
        return this.dealModel;
      case 'Ticket':
        return this.ticketModel;
      case 'Account':
        return this.accountModel;
      case 'Conversation':
        return this.conversationModel;
      default:
        return null;
    }
  }

  async countUsage(
    tenantId: string,
    scope: string,
    tagId: string,
  ): Promise<number> {
    const model = this.modelForScope(scope);
    if (!model) return 0;
    return model.countDocuments({ tenantId, tags: tagId }).exec();
  }

  async removeReferences(
    tenantId: string,
    scope: string,
    tagId: string,
  ): Promise<void> {
    const model = this.modelForScope(scope);
    if (!model) return;
    await model
      .updateMany({ tenantId, tags: tagId }, { $pull: { tags: tagId } })
      .exec();
  }

  async reassignReferences(
    tenantId: string,
    scope: string,
    sourceTagId: string,
    targetTagId: string,
  ): Promise<void> {
    const model = this.modelForScope(scope);
    if (!model) return;
    await model
      .updateMany(
        { tenantId, tags: sourceTagId },
        { $addToSet: { tags: targetTagId } },
      )
      .exec();
    await model
      .updateMany(
        { tenantId, tags: sourceTagId },
        { $pull: { tags: sourceTagId } },
      )
      .exec();
  }
}
