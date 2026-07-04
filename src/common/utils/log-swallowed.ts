import { Logger } from '@nestjs/common';

/**
 * Standardised fire-and-forget error handler.
 *
 * Use this instead of `.catch(() => {})` for any non-critical async
 * operation whose failure should be logged but NOT propagate.
 *
 * Usage:
 * ```ts
 * this.service
 *   .someNonCriticalOp()
 *   .catch(logSwallowed(this.logger, 'someNonCriticalOp'));
 * ```
 *
 * @param logger  NestJS Logger instance (scoped to the caller's class)
 * @param operation  Human-readable label for the operation (used in the log)
 * @returns A `.catch()` handler that warns and swallows the error
 */
export function logSwallowed(
  logger: Logger,
  operation: string,
): (err: unknown) => void {
  return (err: unknown) => {
    const message =
      err instanceof Error ? err.message : String(err ?? 'unknown error');
    logger.warn(`[fire-and-forget] ${operation} failed: ${message}`);
  };
}
