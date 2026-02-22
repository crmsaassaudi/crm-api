import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { UsersModule } from './users/users.module';
import { TenantsModule } from './tenants/tenants.module';
import { FilesModule } from './files/files.module';
import { AuthModule } from './auth/auth.module';
import databaseConfig from './database/config/database.config';
import authConfig from './auth/config/auth.config';
import appConfig from './config/app.config';
import mailConfig from './mail/config/mail.config';
import fileConfig from './files/config/file.config';
import queueConfig from './queue/config/queue.config';
import redisConfig from './redis/config/redis.config';
import keycloakConfig from './auth/config/keycloak.config';
import path from 'path';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { HeaderResolver, I18nModule } from 'nestjs-i18n';
import { MailModule } from './mail/mail.module';
import { HomeModule } from './home/home.module';
import { AllConfigType } from './config/config.type';
import { MailerModule } from './mailer/mailer.module';
import { MongooseModule } from '@nestjs/mongoose';
import { MongooseConfigService } from './database/mongoose-config.service';
import { RedisModule } from './redis/redis.module';
import { QueueModule } from './queue/queue.module';
import { MailQueueModule } from './queue/mail/mail-queue.module';
import { ActivityLogModule } from './activity-log/activity-log.module';
import { HttpResilienceModule } from './common/http/http-resilience.module';
import { CommonCacheModule } from './common/cache/common-cache.module';
import { SocketModule } from './modules/realtime/socket.module';

import {
  AuthGuard,
  KeycloakConnectModule,
  ResourceGuard,
  RoleGuard,
} from 'nest-keycloak-connect';
import { HybridAuthGuard } from './auth/guards/hybrid-auth.guard';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

const infrastructureDatabaseModule = MongooseModule.forRootAsync({
  useClass: MongooseConfigService,
});

import { DatabaseModule } from './database/database.module';
import { ClsModule, ClsService } from 'nestjs-cls';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import { utilities as nestWinstonUtilities } from 'nest-winston';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';
import { jwtDecode } from 'jwt-decode';



import { TenantInterceptor } from './common/interceptors/tenant.interceptor';
import { TenantResolverMiddleware } from './tenants/middleware/tenant-resolver.middleware';

@Module({
  imports: [

    DatabaseModule,
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        databaseConfig,
        authConfig,
        appConfig,
        mailConfig,
        fileConfig,
        queueConfig,
        redisConfig,
        keycloakConfig,
      ],
      envFilePath: ['.env'],
    }),
    KeycloakConnectModule.registerAsync({
      useFactory: (configService: ConfigService<AllConfigType>) => {
        return {
          authServerUrl: configService.getOrThrow('keycloak.authServerUrl', {
            infer: true,
          }),
          realm: configService.getOrThrow('keycloak.realm', { infer: true }),
          clientId: configService.getOrThrow('keycloak.clientId', {
            infer: true,
          }),
          secret: configService.getOrThrow('keycloak.clientSecret', {
            infer: true,
          }),
        };
      },
      inject: [ConfigService],
    }),
    infrastructureDatabaseModule,
    BullBoardModule.forRoot({
      route: '/queues',
      adapter: ExpressAdapter,
    }),
    EventEmitterModule.forRoot(),
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: Request) => {
          const correlationId = req.headers['x-correlation-id'];
          if (Array.isArray(correlationId)) {
            return correlationId[0];
          }
          return correlationId ?? uuidv4();
        },
        setup: (cls, req: Request) => {
          // ── Tenant ID resolution (header → subdomain) ──
          // Priority 1: Explicit header (internal calls / dev / test)
          const headerTenantId = req.headers['x-tenant-id'];
          let tenantId = Array.isArray(headerTenantId)
            ? headerTenantId[0]
            : headerTenantId;

          // Priority 2: Subdomain alias (populated by TenantResolverMiddleware)
          if (!tenantId && (req as any).tenantAlias) {
            tenantId = (req as any).tenantAlias;
          }

          // ── Identity resolution (BFF cookie → Bearer JWT) ──
          // BFF flow: store sid for lazy session resolution in TenantInterceptor
          const sid = (req as any).cookies?.['sid'];
          if (sid) {
            cls.set('sid', sid);
          }

          let userId: string | undefined;
          let email: string | undefined;

          // Bearer JWT (for API clients / nest-keycloak-connect)
          const authHeader = req.headers.authorization;
          if (authHeader?.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            try {
              const decoded: any = jwtDecode(token);
              if (!tenantId) {
                tenantId = decoded.tenantId;
              }
              userId = decoded.sub;
              email = decoded.email;
            } catch {
              // Malformed token — silently skip; auth guard will reject if needed
            }
          }

          // null = no tenant context (platform-level / anonymous request)
          cls.set('tenantId', tenantId ?? null);
          cls.set('userId', userId);
          cls.set('email', email);
        },
      },
    }),
    WinstonModule.forRootAsync({
      useFactory: (clsService: ClsService) => {
        return {
          transports: [
            new winston.transports.Console({
              format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.ms(),
                nestWinstonUtilities.format.nestLike('MyApp', {
                  colors: true,
                  prettyPrint: true,
                }),
                winston.format.printf(
                  ({ context, level, timestamp, message, ms }) => {
                    const correlationId = clsService.getId() || 'N/A';
                    return `[${timestamp}] [${correlationId}] ${level} [${context}] : ${message} ${ms}`;
                  },
                ),
              ),
            }),
          ],
        };
      },
      inject: [ClsService],
    }),
    I18nModule.forRootAsync({
      useFactory: (configService: ConfigService<AllConfigType>) => ({
        fallbackLanguage: configService.getOrThrow('app.fallbackLanguage', {
          infer: true,
        }),
        loaderOptions: { path: path.join(__dirname, '/i18n/'), watch: true },
      }),
      resolvers: [
        {
          use: HeaderResolver,
          useFactory: (configService: ConfigService<AllConfigType>) => {
            return [
              configService.get('app.headerLanguage', {
                infer: true,
              }),
            ];
          },
          inject: [ConfigService],
        },
      ],
      imports: [ConfigModule],
      inject: [ConfigService],
    }),
    UsersModule,
    FilesModule,
    TenantsModule,
    AuthModule,
    MailModule,
    MailerModule,
    HomeModule,
    RedisModule,
    QueueModule,
    MailQueueModule,
    ActivityLogModule,
    HttpResilienceModule,
    CommonCacheModule,
    SocketModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: HybridAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ResourceGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RoleGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: TenantInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantResolverMiddleware).forRoutes('*');
  }
}

