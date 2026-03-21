import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { AgentPresenceService } from './agent-presence.service';
import { AgentStatus } from '../domain/agent-presence';

/**
 * Socket.IO gateway for agent presence and status synchronisation.
 *
 * Events:
 *  - agent:status:update   (client → server)  Agent changes their own status
 *  - agent:heartbeat       (client → server)  Periodic heartbeat to stay online
 *  - agent:status:changed  (server → client)  Broadcast when a peer's status changes
 *  - agent:list            (client → server)  Request all agents for the tenant
 */
@WebSocketGateway({ namespace: '/omni', cors: { origin: '*' } })
export class AgentPresenceGateway {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AgentPresenceGateway.name);

  constructor(private readonly presenceService: AgentPresenceService) {}

  @SubscribeMessage('agent:status:update')
  async handleStatusUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { status: AgentStatus },
  ) {
    const user = client.data.user;
    if (!user) return;

    const tenantId = user.tenantId ?? 'default-tenant';
    const userId = user.id ?? user.sub;

    const presence = await this.presenceService.updateStatus(
      tenantId,
      userId,
      data.status,
      client.id,
    );

    // Broadcast to the entire tenant namespace
    this.server.to(`tenant:${tenantId}`).emit('agent:status:changed', {
      userId,
      status: presence.status,
      activeConversations: presence.activeConversations,
      maxCapacity: presence.maxCapacity,
    });

    this.logger.log(`Agent ${userId} → ${data.status}`);
    return { ok: true, presence };
  }

  @SubscribeMessage('agent:heartbeat')
  async handleHeartbeat(@ConnectedSocket() client: Socket) {
    const user = client.data.user;
    if (!user) return;

    const tenantId = user.tenantId ?? 'default-tenant';
    const userId = user.id ?? user.sub;

    await this.presenceService.heartbeat(tenantId, userId);
    return { ok: true };
  }

  @SubscribeMessage('agent:list')
  async handleListAgents(@ConnectedSocket() client: Socket) {
    const user = client.data.user;
    if (!user) return;

    const tenantId = user.tenantId ?? 'default-tenant';
    const agents = await this.presenceService.getAllAgents(tenantId);

    return { ok: true, agents };
  }

  /**
   * Called by the main connection handler (BaseGateway) when a
   * client connects — registers the agent as available.
   */
  async onAgentConnected(
    tenantId: string,
    userId: string,
    socketId: string,
  ): Promise<void> {
    await this.presenceService.updateStatus(tenantId, userId, 'available', socketId);
    this.server.to(`tenant:${tenantId}`).emit('agent:status:changed', {
      userId,
      status: 'available',
    });
  }

  /**
   * Called when a socket disconnects — mark the agent offline.
   */
  async onAgentDisconnected(
    tenantId: string,
    userId: string,
  ): Promise<void> {
    await this.presenceService.removePresence(tenantId, userId);
    this.server.to(`tenant:${tenantId}`).emit('agent:status:changed', {
      userId,
      status: 'offline',
    });
  }
}
