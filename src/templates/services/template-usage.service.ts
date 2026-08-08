import { Injectable, Logger } from '@nestjs/common';
import { MessageTemplateRepository } from '../infrastructure/persistence/document/repositories/message-template.repository';
import { TemplateUsageRepository } from '../infrastructure/persistence/document/repositories/template-usage.repository';
import { TemplateUsageContext } from '../domain/template-usage';
import { TemplateChannel } from '../domain/template-variant';

/**
 * Records that a template was used, without slowing the send path down.
 *
 * Written once per *action*, not once per recipient: an agent send or an
 * automation node run is one row and one `+1`; a campaign launch is one row
 * and one `+audienceSize`, not one row per recipient. `campaign.schema.ts`
 * already keeps its own `stats.sent` the same way — a denormalized counter
 * instead of a ledger scanned on every read — for exactly this reason: a
 * 10,000-recipient blast must not turn into 10,000 usage writes.
 *
 * Fire-and-forget: a usage-logging failure must never fail the send it is
 * describing.
 */
@Injectable()
export class TemplateUsageService {
  private readonly logger = new Logger(TemplateUsageService.name);

  constructor(
    private readonly usageRepo: TemplateUsageRepository,
    private readonly templateRepo: MessageTemplateRepository,
  ) {}

  record(entry: {
    tenantId: string;
    templateId: string;
    variantId?: string;
    channel: TemplateChannel;
    context: TemplateUsageContext;
    contextId?: string;
    actorId?: string;
    count?: number;
  }): void {
    const count = entry.count ?? 1;
    const at = new Date();
    Promise.all([
      this.usageRepo.record({ ...entry, count }),
      this.templateRepo.recordUsage(entry.tenantId, entry.templateId, count, at),
    ]).catch((err) => {
      this.logger.warn(
        `Failed to record template usage for ${entry.templateId}: ${err.message}`,
      );
    });
  }
}
