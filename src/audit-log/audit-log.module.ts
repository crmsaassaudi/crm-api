import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { AuditLogService } from './audit-log.service';
import {
  AuditLogSchema,
  AuditLogSchemaClass,
} from './entities/audit-log.schema';
import { AuditLogListener } from './listeners/audit-log.listener';
import { AuditLogController } from './audit-log.controller';
import { AuditLogProcessor } from './processors/audit-log.processor';
import { CustomFieldsCacheService } from './services/custom-fields-cache.service';
import { CustomFieldsCacheInvalidationListener } from './listeners/custom-fields-cache-invalidation.listener';
import { UserSchemaClass, UserSchema } from '../users/infrastructure/persistence/document/entities/user.schema';
import { RedisModule } from '../redis/redis.module';
import { isWorkerRuntime } from '../config/runtime-role';

@Module({
  imports: [
    // Isolated DB connection for audit logs.
    // Falls back to main DATABASE_URL if AUDIT_DATABASE_URL is not set.
    MongooseModule.forRootAsync({
      connectionName: 'audit-log-db-connection',
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const isProd = process.env.NODE_ENV === 'production';
        return {
          uri:
            configService.get<string>('AUDIT_DATABASE_URL') ||
            configService.get<string>('DATABASE_URL'),
          dbName:
            configService.get<string>('AUDIT_DATABASE_NAME') ||
            'crm_audit_logs',

          // ── Atlas Resilience (mirrors main connection) ────────────
          serverSelectionTimeoutMS: 45_000,
          socketTimeoutMS: 60_000,
          heartbeatFrequencyMS: 5_000,
          retryWrites: true,
          retryReads: true,
          maxPoolSize: isProd ? 20 : 5,
          minPoolSize: isProd ? 2 : 1,
          autoIndex: !isProd,
        };
      },
      inject: [ConfigService],
    }),

    // Audit log schema on the isolated connection
    MongooseModule.forFeature(
      [
        {
          name: AuditLogSchemaClass.name,
          schema: AuditLogSchema,
        },
      ],
      'audit-log-db-connection',
    ),

    // BullMQ queue for async audit job processing
    BullModule.registerQueue({ name: 'audit-queue' }),

    // BullBoard UI for monitoring
    BullBoardModule.forFeature({
      name: 'audit-queue',
      adapter: BullMQAdapter,
    }),

    // User model on default (main) connection — for actor info population
    MongooseModule.forFeature([
      { name: UserSchemaClass.name, schema: UserSchema },
    ]),

    RedisModule,
  ],
  controllers: [AuditLogController],
  providers: [
    AuditLogService,
    AuditLogListener,
    CustomFieldsCacheService,
    CustomFieldsCacheInvalidationListener,
    // Worker processor: only registered when running as worker process
    // to avoid consuming jobs in the API process
    ...(isWorkerRuntime() ? [AuditLogProcessor] : []),
  ],
  exports: [AuditLogService],
})
export class AuditLogModule {}

