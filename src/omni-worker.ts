import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';

async function bootstrapOmniWorker() {
  process.env.APP_RUNTIME = 'omni';

  const { AppModule } = await import('./app.module');
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
  app.enableShutdownHooks();

  Logger.log('CRM omni-worker service started', 'OmniWorkerBootstrap');
}

bootstrapOmniWorker().catch((err) => {
  console.error(
    '[OmniWorkerBootstrap] Fatal: failed to start omni-worker',
    err,
  );
  process.exit(1);
});
