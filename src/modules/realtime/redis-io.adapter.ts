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

  /**
   * Time budget for the Socket.IO Redis adapter connection.
   *
   * This runs during bootstrap, before `app.listen()`. Without a deadline a Redis
   * endpoint that accepts the TCP connection but never completes the handshake
   * (a DROP rule, a wrong port, a half-open NAT) leaves the process alive,
   * listening on nothing, logging nothing — the container reports "Up" while
   * every request 502s. Failing loudly is strictly better.
   */
  private static readonly CONNECT_TIMEOUT_MS = 15_000;

  async connectToRedis(): Promise<void> {
    const configService = this.app.get(ConfigService);
    const host =
      configService.get<string>('redis.host', { infer: true }) ?? 'localhost';
    const port =
      configService.get<number>('redis.port', { infer: true }) ?? 6379;
    const redisOptions = {
      host,
      port,
      password:
        configService.get<string>('redis.password', {
          infer: true,
        }) ?? undefined,
      db: configService.get<number>('redis.db', { infer: true }) ?? 0,
    };

    const pubClient = new Redis(redisOptions);
    const subClient = pubClient.duplicate();

    const waitForReady = (client: Redis, label: string) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `Socket.IO Redis adapter (${label}) not ready after ` +
                `${RedisIoAdapter.CONNECT_TIMEOUT_MS}ms — host=${host} port=${port}`,
            ),
          );
        }, RedisIoAdapter.CONNECT_TIMEOUT_MS);

        client.once('ready', () => {
          clearTimeout(timer);
          resolve();
        });
        client.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

    try {
      await Promise.all([
        waitForReady(pubClient, 'pub'),
        waitForReady(subClient, 'sub'),
      ]);
    } catch (error) {
      // Release the sockets so the failure does not leave two retrying clients
      // behind for the lifetime of the process.
      pubClient.disconnect();
      subClient.disconnect();
      throw error;
    }

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
    const match = /(?:^|;\s*)sid=([^;]+)/.exec(cookieHeader);
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
