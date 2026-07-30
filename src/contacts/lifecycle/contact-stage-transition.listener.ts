import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  ContactStageTransitionDocument,
  ContactStageTransitionSchemaClass,
} from './contact-stage-transition.schema';

export interface ContactStageChangedEvent {
  eventId: string;
  tenantId: string;
  contactId: string;
  fromStage: string | null;
  toStage: string;
  occurredAt: Date;
  changedById?: string;
  reason?: string;
  direction: 'forward' | 'backward' | 'lateral';
  skippedStages: string[];
}

@Injectable()
export class ContactStageTransitionListener {
  private readonly logger = new Logger(ContactStageTransitionListener.name);

  constructor(
    @InjectModel(ContactStageTransitionSchemaClass.name)
    private readonly model: Model<ContactStageTransitionDocument>,
  ) {}

  @OnEvent('contact.stage.changed', { async: true })
  async record(event: ContactStageChangedEvent): Promise<void> {
    try {
      await this.model
        .updateOne(
          { tenantId: event.tenantId, eventId: event.eventId },
          {
            $setOnInsert: {
              ...event,
              tenantId: new Types.ObjectId(event.tenantId),
              contactId: new Types.ObjectId(event.contactId),
              ...(event.changedById && Types.ObjectId.isValid(event.changedById)
                ? { changedById: new Types.ObjectId(event.changedById) }
                : {}),
            },
          },
          { upsert: true },
        )
        .setOptions({ isPlatformQuery: true } as any)
        .exec();
    } catch (error) {
      this.logger.error(
        `Could not project stage event ${event.eventId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
