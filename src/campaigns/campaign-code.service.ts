import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

const PREFIX = 'CMP-';
const PAD = 5;

/**
 * Per-tenant campaign codes, from the same `counters` collection the ticket
 * numbers come from.
 *
 * A code rather than an ObjectId because this is the identifier that ends up in
 * a conversation with a customer ("why did I get CMP-00042?") and in the UTM tag
 * of a link. It is assigned once and never reused, including after a campaign is
 * archived — reuse would make two different sends indistinguishable in a report.
 */
@Injectable()
export class CampaignCodeService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  static format(seq: number): string {
    return `${PREFIX}${String(seq).padStart(PAD, '0')}`;
  }

  async next(tenantId: string): Promise<string> {
    const result = await this.connection
      .collection('counters')
      .findOneAndUpdate(
        { _id: `campaign_seq:${tenantId}` } as any,
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' },
      );

    return CampaignCodeService.format((result as any)?.seq ?? 1);
  }
}
