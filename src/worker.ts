import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';

async function bootstrapWorker() {
  process.env.APP_RUNTIME = 'worker';

  const { AppModule } = await import('./app.module');
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
  app.enableShutdownHooks();

  Logger.log('CRM worker service started', 'WorkerBootstrap');
}

bootstrapWorker().catch((err) => {
  console.error('[WorkerBootstrap] Fatal: failed to start worker', err);
  process.exit(1);
});
