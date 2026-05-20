import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ContactRepository } from './infrastructure/persistence/document/repositories/contact.repository';

@Injectable()
export class ContactScoringService {
  private readonly logger = new Logger(ContactScoringService.name);

  constructor(private readonly repository: ContactRepository) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async runNightlyScoreRefresh(): Promise<void> {
    const result = await this.repository.recomputeScoresForAllTenants(5_000);
    this.logger.log(
      `Contact scoring refreshed: scanned=${result.scanned}, updated=${result.updated}`,
    );
  }
}
