import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Logger, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../../../config/config.type';

export class BaseGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  protected logger = new Logger(BaseGateway.name);

  constructor(
    protected readonly jwtService: JwtService,
    protected readonly configService: ConfigService<AllConfigType>,
  ) {}

  afterInit(server: Server) {
    this.logger.log('WebSocket Gateway Initialized');
  }

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        (client.handshake.headers.authorization as string)?.split(' ')[1];

      if (!token) {
        this.logger.warn(`Client ${client.id} has no token`);
        client.disconnect();
        return;
      }

      const payload = await this.jwtService.verifyAsync(token, {
        secret: this.configService.getOrThrow('auth.secret', { infer: true }),
      });

      client.data.user = payload;
      const room = `sale:${payload.id}`;
      await client.join(room);

      this.logger.log(
        `Client ${client.id} connected. User: ${payload.id}. Joined room: ${room}`,
      );
    } catch (error) {
      this.logger.error(
        `Connection error for client ${client.id}: ${error.message}`,
      );
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client ${client.id} disconnected`);
  }

  public emitToSale(saleId: string, event: string, payload: any) {
    const room = `sale:${saleId}`;
    this.server.to(room).emit(event, payload);
    this.logger.debug(`Emitted event ${event} to room ${room}`);
  }
}
