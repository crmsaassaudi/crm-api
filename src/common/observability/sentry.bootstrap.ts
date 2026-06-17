import { Logger } from '@nestjs/common';

/**
 * Initialize Sentry if the SDK is installed AND `SENTRY_DSN` is configured.
 *
 * Sentry is intentionally an *optional* dependency. We don't want to add a
 * hard `@sentry/node` import to the production build because:
 *   - Many on-prem customers run without it.
 *   - Self-hosted deployments may not have outbound internet for telemetry.
 *
 * If the package isn't resolvable or the DSN is missing, this is a no-op.
 * Otherwise we tag every event with the current service (api/worker/email)
 * and `NODE_ENV` so the Sentry project filters cleanly.
 */
export async function initSentryIfConfigured(): Promise<void> {
  const logger = new Logger('Sentry');
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    return;
  }

  let sentry: any;
  try {
    // Lazy require so the dependency stays optional.
    sentry = await import('@sentry/node').catch(() => null);
    if (!sentry || typeof sentry.init !== 'function') {
      logger.warn(
        '[Sentry] SENTRY_DSN is set but @sentry/node is not installed — skipping init',
      );
      return;
    }
  } catch {
    return;
  }

  try {
    sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.APP_VERSION || process.env.GIT_SHA,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_RATE) || 0,
      // We do our own secret masking in the logger; Sentry's beforeSend
      // applies the same maskSecrets so anything that escapes a logger call
      // (e.g. uncaught throw) is still scrubbed before leaving the process.
      async beforeSend(event: any) {
        try {
          const { maskSecrets } = await import('../logger/secret-masker');
          return maskSecrets(event);
        } catch {
          return event;
        }
      },
    });
    sentry.setTag('service', process.env.APP_RUNTIME || 'api');
    logger.log('[Sentry] Initialized');
  } catch (err: any) {
    logger.warn(`[Sentry] Init failed: ${err?.message ?? err}`);
  }
}
