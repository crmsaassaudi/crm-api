import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { MailProducer } from './mail.producer';
import { MailProcessor } from './mail.processor';
import { isWorkerRuntime } from '../../config/runtime-role';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'mail',
    }),
    BullBoardModule.forFeature({
      name: 'mail',
      adapter: BullMQAdapter,
    }),
  ],
  providers: [MailProducer, ...(isWorkerRuntime() ? [MailProcessor] : [])],
  exports: [MailProducer],
})
export class MailQueueModule {}
