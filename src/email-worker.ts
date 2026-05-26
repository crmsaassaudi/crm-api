import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';

async function bootstrapEmailWorker() {
  process.env.APP_RUNTIME = 'email-worker';

  const { AppModule } = await import('./app.module');
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
  app.enableShutdownHooks();

  Logger.log('CRM email-worker service started', 'EmailWorkerBootstrap');
}

bootstrapEmailWorker().catch((err) => {
  console.error('[EmailWorkerBootstrap] Fatal: failed to start email-worker', err);
  process.exit(1);
});
