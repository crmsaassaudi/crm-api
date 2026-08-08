import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { TenantThrottlerGuard } from './common/throttler/tenant-throttler.guard';
import { UsersModule } from './users/users.module';
import { TenantsModule } from './tenants/tenants.module';
import { FilesModule } from './files/files.module';
import { AuthModule } from './auth/auth.module';
import databaseConfig from './database/config/database.config';
import authConfig from './auth/config/auth.config';
import appConfig from './config/app.config';
import aiConfig from './config/ai.config';
import mailConfig from './mail/config/mail.config';
import fileConfig from './files/config/file.config';
import queueConfig from './queue/config/queue.config';
import redisConfig from './redis/config/redis.config';
import keycloakConfig from './auth/config/keycloak.config';
import path from 'path';
import { existsSync } from 'fs';
import * as crypto from 'crypto';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { HeaderResolver, I18nModule } from 'nestjs-i18n';
import { MailModule } from './mail/mail.module';
import { HomeModule } from './home/home.module';
import { AllConfigType } from './config/config.type';
import { MailerModule } from './mailer/mailer.module';
import { MongooseModule } from '@nestjs/mongoose';
import { MongooseConfigService } from './database/mongoose-config.service';
import { RedisModule } from './redis/redis.module';
import { DlqModule } from './queue/dlq/dlq.module';
import { EntityAuditModule } from './common/audit/entity-audit.module';
import { ReferencesModule } from './common/references/references.module';
import { QueueModule } from './queue/queue.module';
import { MailQueueModule } from './queue/mail/mail-queue.module';
import { ActivityLogModule } from './activity-log/activity-log.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { HttpResilienceModule } from './common/http/http-resilience.module';
import { CommonCacheModule } from './common/cache/common-cache.module';
import { SocketModule } from './modules/realtime/socket.module';
import { CrmSettingsModule } from './crm-settings/crm-settings.module';
import { AccountsModule } from './accounts/accounts.module';
import { DealsModule } from './deals/deals.module';
import { ContactsModule } from './contacts/contacts.module';
import { TicketsModule } from './tickets/tickets.module';
import { TicketSettingsModule } from './ticket-settings/ticket-settings.module';
import { DealSettingsModule } from './deal-settings/deal-settings.module';
import { AccountSettingsModule } from './account-settings/account-settings.module';
import { TaskSettingsModule } from './task-settings/task-settings.module';
import { LeadScoringModule } from './lead-scoring/lead-scoring.module';

import { TasksModule } from './tasks/tasks.module';
import { CustomFieldsModule } from './custom-fields/custom-fields.module';
import { ObjectManagerModule } from './object-manager/object-manager.module';
import { TagsModule } from './tags/tags.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ChannelsModule } from './channels/channels.module';
import { SlaPoliciesModule } from './sla-policies/sla-policies.module';
import { EscalationPoliciesModule } from './escalation-policies/escalation-policies.module';
import { AutomationRulesModule } from './automation-rules/automation-rules.module';
import { GroupsModule } from './groups/groups.module';
import { OrgUnitsModule } from './org-units/org-units.module';
import { OmniInboundModule } from './omni-inbound/omni-inbound.module';
import { DataVisibilityModule } from './data-visibility/data-visibility.module';
import { ListViewsModule } from './list-views/list-views.module';
import { AssignmentModule } from './assignment/assignment.module';
import { MailInboundModule } from './channels/mail-inbound/mail-inbound.module';
import { ReadStateSyncModule } from './queue/read-state-sync/read-state-sync.module';
import { OnboardingModule } from './tenants/onboarding.module';
import { ObservabilityModule } from './observability/observability.module';
import { NotesModule } from './notes/notes.module';
import { SystemSettingsModule } from './system-settings/system-settings.module';
import { AiVideoModule } from './ai-video/ai-video.module';
import { SocialContentModule } from './social-posts/social-posts.module';
import { ReportsModule } from './reports/reports.module';
import { HealthModule } from './health/health.module';
import { SharedImportModule } from './common/import/import.module';
import { SharedExportModule } from './common/export/export.module';
import { TemplatesModule } from './templates/templates.module';
import { AuthorizationModule } from './common/permissions/authorization.module';
import { AuthzAuditModule } from './common/authz-audit/authz-audit.module';
import { LivechatModule } from './livechat/livechat.module';
import { TelegramModule } from './channels/telegram/telegram.module';
import { DashboardsModule } from './dashboards/dashboards.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { InboxesModule } from './inboxes/inboxes.module';
import { SearchModule } from './search/search.module';
import openSearchConfig from './search/config/opensearch.config';

import {
  KeycloakConnectModule,
  ResourceGuard,
  RoleGuard,
} from 'nest-keycloak-connect';
import { HybridAuthGuard } from './auth/guards/hybrid-auth.guard';
import { PermissionGuard } from './common/permissions';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { DataVisibilityInterceptor } from './data-visibility/data-visibility.interceptor';

const infrastructureDatabaseModule = MongooseModule.forRootAsync({
  useClass: MongooseConfigService,
});

import { DatabaseModule } from './database/database.module';
import { ClsModule, ClsService } from 'nestjs-cls';
import { WinstonModule } from 'nest-winston';
import { winstonConfig } from './common/logger/winston.config';
import { ulid } from 'ulid';
import { Request } from 'express';

import { TenantInterceptor } from './common/interceptors/tenant.interceptor';
import { TenantResolverMiddleware } from './tenants/middleware/tenant-resolver.middleware';
import { MaintenanceModeGuard } from './system-settings/maintenance-mode.guard';

const nodeEnv = process.env.NODE_ENV ?? 'development';
const envFilePath = [
  `.env.${nodeEnv}.local`,
  `.env.${nodeEnv}`,
  '.env.local',
  '.env',
];

/**
 * Build the basic-auth middleware that protects /queues (bull-board).
 * Production must set both env vars; otherwise the endpoint is refused
 * outright to prevent accidental public exposure of queue internals.
 */
function bullBoardBasicAuth() {
  const user = process.env.BULL_BOARD_USER;
  const pass = process.env.BULL_BOARD_PASSWORD;

  return (req: any, res: any, next: any) => {
    // Fail closed regardless of NODE_ENV. Keying this on `production` meant an
    // unset NODE_ENV published job payloads (and retry/remove controls) to
    // anonymous callers; setting the two env vars is a one-line dev cost.
    if (!user || !pass) {
      res.status(503).send('Bull-board credentials not configured');
      return;
    }
    const header = req.headers['authorization'] || '';
    const expected =
      'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    // Use constant-time comparison to prevent timing attacks that could
    // leak credential material byte-by-byte via response latency.
    if (
      header.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected))
    ) {
      return next();
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="bull-board"');
    res.status(401).send('Authentication required');
  };
}

@Module({
  imports: [
    DatabaseModule,
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        databaseConfig,
        authConfig,
        appConfig,
        aiConfig,
        mailConfig,
        fileConfig,
        queueConfig,
        redisConfig,
        keycloakConfig,
        openSearchConfig,
      ],
      envFilePath,
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
    SearchModule,
    ThrottlerModule.forRoot([
      // Burst protection: block aggressive bots hammering in quick succession
      { name: 'burst', ttl: 1_000, limit: 10 },
      // Standard: 100 requests per minute per IP (existing behaviour)
      { name: 'medium', ttl: 60_000, limit: 100 },
      // Long-term: prevent sustained low-rate abuse (e.g., credential stuffing)
      { name: 'long', ttl: 900_000, limit: 500 },
    ]),
    BullBoardModule.forRoot({
      route: '/queues',
      adapter: ExpressAdapter,
      // Basic-auth gate so /queues isn't exposed unauthenticated. In dev
      // the default creds are placeholders; in prod both must be set or
      // the middleware refuses access entirely.
      middleware: bullBoardBasicAuth(),
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
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
          return correlationId ?? ulid();
        },
        setup: (cls, req: Request) => {
          // CLS middleware only sets initial values from synchronous sources.
          // Async resolution (DB lookups, session reads) is handled by TenantInterceptor.

          // Store subdomain alias for TenantInterceptor to resolve
          if ((req as any).tenantAlias) {
            cls.set('tenantAlias', (req as any).tenantAlias);
          }

          // Store sid cookie for TenantInterceptor to resolve session
          const sid = (req as any).cookies?.['sid'];
          if (sid) {
            cls.set('sid', sid);
          }

          // Initialize empty — TenantInterceptor will populate these
          cls.set('tenantId', null);
          cls.set('userId', undefined);
          cls.set('email', undefined);
        },
      },
    }),
    // Logging config lives in `common/logger/winston.config.ts` and must stay
    // there rather than being inlined: it routes every message and meta field
    // through `maskSecrets`, honours LOG_FORMAT so production ships JSON lines
    // instead of ANSI, and carries tenantId/userId/service plus structured meta
    // on every line. `sentry.bootstrap.ts` reasons from the assumption that the
    // masking is on.
    WinstonModule.forRootAsync({
      useFactory: (clsService: ClsService) => winstonConfig(clsService),
      inject: [ClsService],
    }),
    I18nModule.forRootAsync({
      useFactory: (configService: ConfigService<AllConfigType>) => {
        const distI18nPath = path.join(__dirname, 'i18n');
        const sourceI18nPath = path.join(process.cwd(), 'src', 'i18n');
        const i18nPath = existsSync(distI18nPath)
          ? distI18nPath
          : sourceI18nPath;

        return {
          fallbackLanguage: configService.getOrThrow('app.fallbackLanguage', {
            infer: true,
          }),
          loaderOptions: {
            path: i18nPath,
            watch: process.env.NODE_ENV !== 'production',
          },
        };
      },
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
    HealthModule,
    RedisModule,
    EntityAuditModule,
    // Supplies RetentionPurgeRunner to the five domains that purge.
    ReferencesModule,
    DlqModule,
    QueueModule,
    MailQueueModule,
    ActivityLogModule,
    AuditLogModule,
    HttpResilienceModule,
    CommonCacheModule,
    SocketModule,
    CrmSettingsModule,
    AccountsModule,
    DealsModule,
    ContactsModule,
    TicketsModule,
    LeadScoringModule,
    TicketSettingsModule,
    DealSettingsModule,
    AccountSettingsModule,
    TaskSettingsModule,
    TasksModule,
    CustomFieldsModule,
    ObjectManagerModule,
    TagsModule,
    NotificationsModule,
    ChannelsModule,
    InboxesModule,
    SlaPoliciesModule,
    EscalationPoliciesModule,
    AutomationRulesModule,
    GroupsModule,
    OrgUnitsModule,
    OmniInboundModule,
    DataVisibilityModule,
    ListViewsModule,
    AssignmentModule,
    MailInboundModule,
    ReadStateSyncModule,
    OnboardingModule,
    ObservabilityModule,
    NotesModule,
    SystemSettingsModule,
    AiVideoModule,
    SocialContentModule,
    ReportsModule,
    SharedImportModule,
    SharedExportModule,
    TemplatesModule,
    AuthorizationModule,
    AuthzAuditModule,
    LivechatModule,
    TelegramModule,
    DashboardsModule,
    CampaignsModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: MaintenanceModeGuard,
    },
    {
      // TenantThrottlerGuard keys throttle by tenantId+userId so one noisy
      // tenant cannot exhaust another tenant's budget; falls back to IP
      // for unauthenticated paths.
      provide: APP_GUARD,
      useClass: TenantThrottlerGuard,
    },
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
      provide: APP_GUARD,
      useClass: PermissionGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: TenantInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: DataVisibilityInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantResolverMiddleware).forRoutes('*');
  }
}
