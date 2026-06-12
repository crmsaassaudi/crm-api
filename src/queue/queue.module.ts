import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { AllConfigType } from '../config/config.type';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: (configService: ConfigService<AllConfigType>) => ({
        connection: {
          host: configService.get('queue.host', { infer: true }),
          port: configService.get('queue.port', { infer: true }),
          password: configService.get('queue.password', { infer: true }),
          db: configService.get('queue.db', { infer: true }),
          // CRIT-06: BullMQ ^5 requires these for the blocking BRPOPLPUSH/BZPOPMIN
          // connection. Without them, a Redis blip triggers MaxRetriesPerRequestError
          // and workers silently stop consuming — backlog grows invisibly.
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        },
      }),
      inject: [ConfigService],
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
