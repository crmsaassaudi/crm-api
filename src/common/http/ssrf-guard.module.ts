import { Module } from '@nestjs/common';
import { SsrfGuardService } from './ssrf-guard.service';

/**
 * Provides {@link SsrfGuardService} to any module that fetches a URL it did not
 * author.
 *
 * The guard used to live inside `automation-rules`, which made it look like a
 * webhook-only concern. It is not: every server-side fetch of a caller-supplied
 * URL is the same vulnerability, and the bot media path was fetching one without
 * any check at all. Keeping the provider here — with no dependencies of its own —
 * means importing it can never introduce a DI cycle.
 */
@Module({
  providers: [SsrfGuardService],
  exports: [SsrfGuardService],
})
export class SsrfGuardModule {}
