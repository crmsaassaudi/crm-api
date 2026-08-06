import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

/** Prefix and zero-padding of a human-quoted ticket number. */
const PREFIX = 'TKT-';
const PAD = 5;

/**
 * The single source of ticket numbers.
 *
 * It exists because there were two. The API drew from a per-tenant counter and
 * produced `TKT-00001`; the import generated `TKT-<ulid suffix>` and never
 * touched the counter. One tenant therefore held two incompatible numbering
 * schemes, and an imported ticket could collide with a future API-issued number
 * — the number support reads back to a customer over the phone.
 *
 * `reserve(n)` takes a contiguous block in one round trip so a 100k-row import
 * does not perform 100k counter updates.
 */
@Injectable()
export class TicketNumberService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  /** Format a sequence number the way the whole product displays it. */
  static format(seq: number): string {
    return `${PREFIX}${String(seq).padStart(PAD, '0')}`;
  }

  /** The next single number for `tenantId`. */
  async next(tenantId: string): Promise<string> {
    const [number] = await this.reserve(tenantId, 1);
    return number;
  }

  /**
   * Reserve `count` consecutive numbers in one atomic increment.
   *
   * The block is consumed whether or not every row lands, so a partially failed
   * import leaves a gap rather than reusing a number.
   */
  async reserve(tenantId: string, count: number): Promise<string[]> {
    if (count < 1) return [];
    const result = await this.connection
      .collection('counters')
      .findOneAndUpdate(
        { _id: `ticket_seq:${tenantId}` } as any,
        { $inc: { seq: count } },
        { upsert: true, returnDocument: 'after' },
      );

    const last = (result as any)?.seq ?? count;
    const first = last - count + 1;
    return Array.from({ length: count }, (_, index) =>
      TicketNumberService.format(first + index),
    );
  }
}
