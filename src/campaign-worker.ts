import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';

/**
 * The campaign send pool.
 *
 * Deliberately not part of `APP_RUNTIME=worker`: one 500K-contact campaign
 * materialises ~5.000 send jobs, and draining them inside the generic worker
 * pool leaves every contact import and CSV export queued behind a batch three
 * orders of magnitude larger than they are.
 *
 * Scale this independently of the other pools — its throughput ceiling is the
 * slowest provider a tenant uses, not CPU. `CAMPAIGN_SEND_CONCURRENCY` is
 * concurrency at the provider.
 */
async function bootstrapCampaignWorker() {
  process.env.APP_RUNTIME = 'campaign';

  const { AppModule } = await import('./app.module');
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
  app.enableShutdownHooks();

  Logger.log('CRM campaign-worker service started', 'CampaignWorkerBootstrap');
}

bootstrapCampaignWorker().catch((err) => {
  console.error(
    '[CampaignWorkerBootstrap] Fatal: failed to start campaign-worker',
    err,
  );
  process.exit(1);
});
