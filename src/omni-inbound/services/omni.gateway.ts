import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OmniPayload } from '../domain/omni-payload';
import { AgentPresenceService } from './agent-presence.service';
import { AgentPresenceGateway } from './agent-presence.gateway';
import { OutboundService } from './outbound.service';

/**
 * Primary Socket.IO gateway for omni-channel real-time messaging.
 *
 * Event table:
 * ┌──────────────────────────────────┬────────────┬────────────────────────────────────┐
 * │ Event                            │ Direction  │ Purpose                            │
 * ├──────────────────────────────────┼────────────┼────────────────────────────────────┤
 * │ omni:message:send                │ C → S      │ Agent sends a reply                │
 * │ omni:message:new                 │ S → C      │ New inbound message (from webhook) │
 * │ omni:message:ack                 │ S → C      │ Server confirms message receipt    │
 * │ omni:typing:start / :stop        │ C ↔ S      │ Typing indicators                  │
 * │ omni:conversation:claim          │ C → S      │ Agent claims a conversation        │
 * │ omni:conversation:claimed        │ S → C      │ Broadcast who claimed              │
 * │ omni:collision                   │ S → C      │ Two agents claim the same conv.    │
 * └──────────────────────────────────┴────────────┴────────────────────────────────────┘
 */
@WebSocketGateway({ namespace: '/omni', cors: { origin: '*' } })
export class OmniGateway {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(OmniGateway.name);

  /** In-memory map: conversationId → userId who is currently claiming it */
  private claimLocks = new Map<string, { userId: string; at: Date }>();

  constructor(
    private readonly presenceService: AgentPresenceService,
    private readonly presenceGateway: AgentPresenceGateway,
    private readonly outboundService: OutboundService,
  ) {}

  // ─── Connection lifecycle ──────────────────────────────────────────

  async handleConnection(client: Socket) {
    const user = client.data.user;
    if (!user) return;

    const tenantId = user.tenantId ?? 'default-tenant';
    const userId = user.id ?? user.sub;

    // Join tenant room for broadcast events
    await client.join(`tenant:${tenantId}`);
    this.logger.log(`Agent ${userId} connected to /omni`);

    // Register agent presence
    await this.presenceGateway.onAgentConnected(tenantId, userId, client.id);
  }

  async handleDisconnect(client: Socket) {
    const user = client.data.user;
    if (!user) return;

    const tenantId = user.tenantId ?? 'default-tenant';
    const userId = user.id ?? user.sub;

    await this.presenceGateway.onAgentDisconnected(tenantId, userId);
    this.logger.log(`Agent ${userId} disconnected from /omni`);
  }

  // ─── Messaging ─────────────────────────────────────────────────────

  @SubscribeMessage('omni:message:send')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      conversationId: string;
      content: string;
      messageType?: string;
      tempId?: string; // Client-side optimistic ID for matching acks
    },
  ) {
    const user = client.data.user;
    if (!user) return { ok: false, error: 'Unauthenticated' };

    const userId = user.id ?? user.sub;
    const tenantId = user.tenantId ?? 'default-tenant';

    this.logger.log(
      `Agent ${userId} sends message to conversation ${data.conversationId}`,
    );

    try {
      // Persist and send (outbound logic)
      const result = await this.outboundService.sendAgentMessage({
        tenantId,
        conversationId: data.conversationId,
        agentId: userId,
        content: data.content,
        messageType: data.messageType,
        source: 'socket',
      });

      const ack = {
        ok: true,
        tempId: data.tempId,
        messageId: result.messageId,
        timestamp: new Date().toISOString(),
      };

      // Broadcast the message to other agents watching this conversation
      client.to(`conversation:${data.conversationId}`).emit('omni:message:new', {
        conversationId: data.conversationId,
        senderId: userId,
        senderType: 'agent',
        messageType: data.messageType ?? 'text',
        content: data.content,
        messageId: ack.messageId,
        timestamp: ack.timestamp,
      });

      return ack;
    } catch (error) {
      this.logger.error(`SendMessage error: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  /**
   * Listener for the `omni.message.received` domain event,
   * emitted by InboundProcessorService when a webhook arrives.
   *
   * Broadcasts the normalized message to agents via Socket.IO.
   */
  @OnEvent('omni.message.received')
  handleInboundMessage(payload: OmniPayload) {
    this.logger.log(
      `Broadcasting inbound ${payload.channelType} message to tenant ${payload.tenantId}`,
    );

    this.server
      .to(`tenant:${payload.tenantId}`)
      .emit('omni:message:new', payload);
  }

  /**
   * Listener for `omni.message.sent` domain event.
   * Only broadcasts to the room if the message was sent via REST (HTTP).
   * If sent via socket, `handleSendMessage` already emits to clients.
   */
  @OnEvent('omni.message.sent')
  handleOutboundMessage(payload: any) {
    if (payload.source === 'http') {
      this.logger.log(`Broadcasting HTTP-sent message to conversation ${payload.conversationId}`);
      this.server
        .to(`conversation:${payload.conversationId}`)
        .emit('omni:message:new', {
          conversationId: payload.conversationId,
          senderId: payload.senderId,
          senderType: payload.senderType,
          messageType: payload.messageType,
          content: payload.content,
          messageId: payload.messageId,
          timestamp: payload.timestamp,
        });
    }
  }

  // ─── Typing indicators ─────────────────────────────────────────────

  @SubscribeMessage('omni:typing:start')
  handleTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const user = client.data.user;
    if (!user) return;

    client.to(`conversation:${data.conversationId}`).emit('omni:typing:start', {
      conversationId: data.conversationId,
      userId: user.id ?? user.sub,
      userName: user.name ?? 'Agent',
    });
  }

  @SubscribeMessage('omni:typing:stop')
  handleTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const user = client.data.user;
    if (!user) return;

    client.to(`conversation:${data.conversationId}`).emit('omni:typing:stop', {
      conversationId: data.conversationId,
      userId: user.id ?? user.sub,
    });
  }

  // ─── Collision detection ────────────────────────────────────────────

  @SubscribeMessage('omni:conversation:claim')
  async handleClaim(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const user = client.data.user;
    if (!user) return { ok: false, error: 'Unauthenticated' };

    const userId = user.id ?? user.sub;
    const tenantId = user.tenantId ?? 'default-tenant';
    const { conversationId } = data;

    // Check for existing claim
    const existingClaim = this.claimLocks.get(conversationId);
    if (existingClaim && existingClaim.userId !== userId) {
      // Collision! Another agent already claimed this conversation
      const timeSinceClaim =
        Date.now() - existingClaim.at.getTime();
      const STALE_CLAIM_MS = 5 * 60 * 1000; // 5 minutes

      if (timeSinceClaim < STALE_CLAIM_MS) {
        // Active claim exists → notify the new agent about collision
        client.emit('omni:collision', {
          conversationId,
          claimedBy: existingClaim.userId,
          claimedAt: existingClaim.at.toISOString(),
          message: 'This conversation is already claimed by another agent.',
        });

        this.logger.warn(
          `Collision: Agent ${userId} tried to claim conversation ` +
            `${conversationId} already claimed by ${existingClaim.userId}`,
        );

        return { ok: false, error: 'Already claimed', claimedBy: existingClaim.userId };
      }
      // Stale claim → allow override
    }

    // Set the claim
    this.claimLocks.set(conversationId, { userId, at: new Date() });

    // Try to assign the conversation capacity to this agent
    const assigned = await this.presenceService.assignConversation(
      tenantId,
      userId,
    );

    if (!assigned) {
      this.claimLocks.delete(conversationId);
      return { ok: false, error: 'Agent at capacity' };
    }

    // Join the conversation room for targeted events
    await client.join(`conversation:${conversationId}`);

    // Broadcast to the whole tenant that this conversation is claimed
    this.server.to(`tenant:${tenantId}`).emit('omni:conversation:claimed', {
      conversationId,
      claimedBy: userId,
      claimedAt: new Date().toISOString(),
    });

    this.logger.log(`Agent ${userId} claimed conversation ${conversationId}`);
    return { ok: true };
  }
}
