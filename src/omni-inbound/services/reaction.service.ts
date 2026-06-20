import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import {
  OmniMessageSchemaClass,
  OmniMessageDocument,
} from '../infrastructure/persistence/document/entities/omni-message.schema';
import { OmniReactionPayload } from '../domain/omni-reaction-payload';

/**
 * Centralized reaction handler — single logic for ALL channels.
 *
 * Listens for 'omni.reaction.inbound' events (emitted by InboundProcessor
 * or LivechatGateway) and performs upsert/remove on the message document.
 *
 * After persisting, emits 'omni.reaction.persisted' so gateways can
 * broadcast the change in real-time to all connected clients.
 */
@Injectable()
export class ReactionService {
  private readonly logger = new Logger(ReactionService.name);

  constructor(
    @InjectModel(OmniMessageSchemaClass.name)
    private readonly messageModel: Model<OmniMessageDocument>,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService,
  ) {}

  /**
   * Handle an inbound reaction from any channel.
   *
   * Flow:
   * 1. Find the target message by externalMessageId (or internal _id)
   * 2. Upsert or remove the reaction
   * 3. Emit 'omni.reaction.persisted' for real-time broadcast
   */
  @OnEvent('omni.reaction.inbound')
  async handleReaction(payload: OmniReactionPayload): Promise<void> {
    try {
      // Wrap in tenant CLS context — @OnEvent handlers run outside the
      // original HTTP/WebSocket CLS scope, so the Mongoose tenant-filter
      // plugin requires activeTenantId in CLS for all DB operations.
      await runWithTenantContext(this.cls, payload.tenantId, async () => {
        // Resolve message — try internal ID first, then externalMessageId
        let message: OmniMessageDocument | null = null;

        if (payload.messageId) {
          message = await this.messageModel.findById(payload.messageId).exec();
        }

        if (!message) {
          message = await this.messageModel
            .findOne({ externalMessageId: payload.externalMessageId })
            .exec();
        }

        if (!message) {
          this.logger.warn(
            `Reaction target not found: externalMessageId=${payload.externalMessageId}, ` +
              `channel=${payload.channelType}`,
          );
          return;
        }

        const messageId = message._id.toString();
        const conversationId = message.conversationId;

        if (payload.action === 'unreact') {
          // Remove this sender's reaction
          await this.messageModel.updateOne(
            { _id: message._id },
            {
              $pull: {
                reactions: { senderId: payload.senderId },
              },
            },
          );

          this.logger.debug(
            `Removed reaction from ${payload.senderId} on message ${messageId}`,
          );
        } else {
          // Upsert: remove existing reaction by this sender, then add new one
          await this.messageModel.updateOne(
            { _id: message._id },
            {
              $pull: {
                reactions: { senderId: payload.senderId },
              },
            },
          );

          await this.messageModel.updateOne(
            { _id: message._id },
            {
              $push: {
                reactions: {
                  emoji: payload.emoji,
                  senderId: payload.senderId,
                  senderType: payload.senderType,
                  createdAt: payload.timestamp,
                },
              },
            },
          );

          this.logger.debug(
            `Added reaction ${payload.emoji} from ${payload.senderId} on message ${messageId}`,
          );
        }

        // Fetch updated reactions
        const updated = await this.messageModel
          .findById(message._id)
          .select('reactions')
          .lean()
          .exec();

        // Broadcast to all connected clients
        this.eventEmitter.emit('omni.reaction.persisted', {
          tenantId: payload.tenantId,
          channelType: payload.channelType,
          conversationId,
          messageId,
          externalMessageId: payload.externalMessageId,
          reactions: updated?.reactions ?? [],
          // Include the triggering reaction for targeted UI updates
          trigger: {
            emoji: payload.emoji,
            senderId: payload.senderId,
            senderType: payload.senderType,
            action: payload.action,
          },
        });
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to process reaction: ${error?.message ?? String(error)}`,
        error?.stack,
      );
    }
  }
}
