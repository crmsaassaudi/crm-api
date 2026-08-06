import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';

/** What a customer is worth, recomputed from that customer's deals. */
export interface ContactValue {
  totalRevenue: number;
  dealsCount: number;
  wonDealsCount: number;
  firstPurchaseAt: Date | null;
  lastPurchaseAt: Date | null;
}

const ZERO: ContactValue = {
  totalRevenue: 0,
  dealsCount: 0,
  wonDealsCount: 0,
  firstPurchaseAt: null,
  lastPurchaseAt: null,
};

/**
 * ContactValueRollupService — denormalises deal outcomes onto the contact, so
 * "top spenders" and "bought once, never again" are one indexed query rather
 * than a `$lookup` per row on every list page.
 *
 * SINGLE-CURRENCY BY DESIGN. `totalRevenue` sums `deal.value` without
 * converting, which is correct only when a tenant sells in one currency — the
 * same position the deal reports take (`detectCurrencyMix` warns rather than
 * converts), because a conversion needs a rate source and a rate-at-close vs
 * rate-today policy, which is a business decision rather than a default.
 */
@Injectable()
export class ContactValueRollupService {
  private readonly logger = new Logger(ContactValueRollupService.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  /**
   * Recompute the affected contacts whenever a deal changes.
   *
   * Subscribes to the audit event the deals service already emits rather than
   * asking DealsService for a new one: ContactsModule imports DealsModule, so a
   * call in the other direction is a cycle.
   *
   * The snapshots cannot be trusted for `contactIds` — bulk-tag and delete emit
   * partial ones (`{tagsAdded}`, `{_deleted:true}`) — so the deal is re-read.
   * The OLD snapshot still matters: a contact REMOVED from a deal must have its
   * total reduced, and it is no longer reachable from the deal.
   */
  @OnEvent('deal.created', { async: true })
  @OnEvent('deal.updated', { async: true })
  async onDealChanged(payload: {
    tenantId?: string;
    entityId?: string;
    oldSnapshot?: { contactIds?: string[] };
    newSnapshot?: { contactIds?: string[] };
  }): Promise<void> {
    if (!payload?.tenantId || !payload.entityId) return;

    try {
      // Scoped by tenant as well as id: the raw driver bypasses the tenant
      // Mongoose plugin, so an id-only read here would be a cross-tenant lookup
      // that happens to be correct only because the id came from this tenant.
      const deal = await this.connection.collection('deals').findOne(
        {
          _id: new Types.ObjectId(payload.entityId),
          tenantId: new Types.ObjectId(payload.tenantId),
        },
        { projection: { contactIds: 1 } },
      );

      const affected = new Set<string>(
        [
          ...(deal?.contactIds ?? []),
          ...(payload.newSnapshot?.contactIds ?? []),
          ...(payload.oldSnapshot?.contactIds ?? []),
        ].map(String),
      );

      for (const contactId of affected) {
        await this.recompute(payload.tenantId, contactId);
      }
    } catch (err) {
      // A rollup is derived data: failing it must not fail the deal write that
      // triggered it. The nightly reconcile repairs whatever this missed.
      this.logger.warn(
        `Contact value rollup failed for deal ${payload.entityId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Recompute and persist one contact's value. Returns what was written. */
  async recompute(tenantId: string, contactId: string): Promise<ContactValue> {
    if (!Types.ObjectId.isValid(contactId)) return ZERO;

    const value = await this.computeValue(tenantId, contactId);

    await this.connection.collection('contacts').updateOne(
      {
        _id: new Types.ObjectId(contactId),
        tenantId: new Types.ObjectId(tenantId),
      },
      { $set: { ...value } },
    );

    return value;
  }

  /**
   * Aggregate one contact's deals.
   *
   * Won deals only for revenue and purchase dates — an open deal is a hope, not
   * money — while `dealsCount` counts every live deal, because "how many deals
   * has this person had" and "how many did they buy" are different questions and
   * a pipeline report needs the first.
   */
  private async computeValue(
    tenantId: string,
    contactId: string,
  ): Promise<ContactValue> {
    const [row] = await this.connection
      .collection('deals')
      .aggregate<{
        totalRevenue: number;
        dealsCount: number;
        wonDealsCount: number;
        firstPurchaseAt: Date | null;
        lastPurchaseAt: Date | null;
      }>([
        {
          $match: {
            tenantId: new Types.ObjectId(tenantId),
            contactIds: new Types.ObjectId(contactId),
            deletedAt: null,
          },
        },
        {
          $group: {
            _id: null,
            dealsCount: { $sum: 1 },
            wonDealsCount: {
              $sum: { $cond: [{ $ifNull: ['$wonAt', false] }, 1, 0] },
            },
            totalRevenue: {
              $sum: {
                $cond: [
                  { $ifNull: ['$wonAt', false] },
                  { $ifNull: ['$value', 0] },
                  0,
                ],
              },
            },
            firstPurchaseAt: { $min: '$wonAt' },
            lastPurchaseAt: { $max: '$wonAt' },
          },
        },
      ])
      .toArray();

    if (!row) return ZERO;

    return {
      totalRevenue: row.totalRevenue ?? 0,
      dealsCount: row.dealsCount ?? 0,
      wonDealsCount: row.wonDealsCount ?? 0,
      firstPurchaseAt: row.firstPurchaseAt ?? null,
      lastPurchaseAt: row.lastPurchaseAt ?? null,
    };
  }
}
