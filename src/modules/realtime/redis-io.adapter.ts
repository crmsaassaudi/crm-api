import { IoAdapter } from '@nestjs/platform-socket.io';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { Server, ServerOptions, Socket } from 'socket.io';
import { SessionService } from '../../auth/services/session.service';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;

  constructor(private readonly app: INestApplication) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const configService = this.app.get(ConfigService);
    const redisOptions = {
      host:
        configService.get<string>('redis.host', {
          infer: true,
        }) ?? 'localhost',
      port: configService.get<number>('redis.port', { infer: true }) ?? 6379,
      password:
        configService.get<string>('redis.password', {
          infer: true,
        }) || undefined,
      db: configService.get<number>('redis.db', { infer: true }) ?? 0,
    };

    const pubClient = new Redis(redisOptions);
    const subClient = pubClient.duplicate();

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        pubClient.once('ready', resolve);
        pubClient.once('error', reject);
      }),
      new Promise<void>((resolve, reject) => {
        subClient.once('ready', resolve);
        subClient.once('error', reject);
      }),
    ]);

    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server: Server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);

    const sessionService = this.app.get(SessionService);
    server.use(async (socket: Socket, next) => {
      try {
        const sid = this.extractSid(socket);
        if (!sid) {
          return next(
            new Error('Authentication required: missing session cookie'),
          );
        }

        const session = await sessionService.getSession(sid);
        if (!session) {
          return next(
            new Error('Authentication required: session invalid or expired'),
          );
        }

        socket.data.sid = sid;
        socket.data.userId = session.userId;
        next();
      } catch {
        next(new Error('Authentication error'));
      }
    });

    return server;
  }

  private extractSid(socket: Socket): string | null {
    // Cookie-based sid (primary — BFF pattern)
    const cookieHeader = socket.handshake.headers.cookie ?? '';
    const match = cookieHeader.match(/(?:^|;\s*)sid=([^;]+)/);
    if (match?.[1]) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }

    // Auth header fallback (Bearer <sid>)
    const auth = socket.handshake.auth?.token as string | undefined;
    if (auth?.startsWith('Bearer ')) {
      return auth.slice(7);
    }

    return null;
  }
}
