import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { ReportDigestService } from './report-digest.service';
import { RequirePermission } from '../../common/permissions/require-permission.decorator';

/**
 * Admin endpoint to trigger the weekly digest on demand.
 * Useful for testing or ad-hoc report sends.
 *
 * POST /v1/reports/digest/send
 * Body: { recipients: string[] }
 */
@Controller('v1/reports/digest')
export class ReportDigestController {
  constructor(private readonly digestService: ReportDigestService) {}

  @Post('send')
  @HttpCode(202)
  @RequirePermission('view', 'omni_reports')
  async triggerDigest(
    @Body() body: { recipients?: string[] },
  ): Promise<{ message: string }> {
    const recipients = body.recipients ?? [];
    if (recipients.length === 0) {
      return {
        message:
          'No recipients provided — use DIGEST_EMAIL_RECIPIENTS env var or supply recipients array',
      };
    }
    await this.digestService.triggerManual(recipients);
    return { message: `Digest sent to ${recipients.length} recipient(s)` };
  }
}
