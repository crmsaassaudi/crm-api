import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import {
  DealSchemaClass,
  DealSchemaDocument,
} from './infrastructure/persistence/document/entities/deal.schema';

/**
 * Keeps `deal.accountName` (a denormalized cache, matched directly in every
 * deal list/search query) from drifting once an Account is renamed.
 *
 * Nothing previously refreshed it — renaming "Acme" to "Acme Corp" left every
 * existing deal showing and matching "Acme" until someone ran a manual
 * backfill. Fire-and-forget: a failed sync must not fail the account rename
 * that triggered it; the next edit to any of those deals would still carry
 * the stale name until this catches up, so a warning is logged rather than
 * swallowed silently.
 */
@Injectable()
export class DealAccountNameSyncListener {
  private readonly logger = new Logger(DealAccountNameSyncListener.name);

  constructor(
    @InjectModel(DealSchemaClass.name)
    private readonly dealModel: Model<DealSchemaDocument>,
  ) {}

  @OnEvent('account.renamed')
  async onAccountRenamed(payload: {
    tenantId: string;
    accountId: string;
    name: string;
  }): Promise<void> {
    const { tenantId, accountId, name } = payload || ({} as any);
    if (!tenantId || !accountId || !name) return;

    try {
      const result = await this.dealModel
        .updateMany(
          { tenantId, accountId, deletedAt: null },
          { $set: { accountName: name } },
        )
        .setOptions({ isPlatformQuery: true } as any)
        .exec();

      if (result.modifiedCount > 0) {
        this.logger.log(
          `Synced accountName → "${name}" on ${result.modifiedCount} deal(s) for account ${accountId}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Deal accountName sync failed for account ${accountId} (tenant ${tenantId}): ${err.message}`,
      );
    }
  }
}
