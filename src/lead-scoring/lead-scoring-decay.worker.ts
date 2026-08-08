import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  ContactSchemaClass,
  ContactSchemaDocument,
} from '../contacts/infrastructure/persistence/document/entities/contact.schema';

/**
 * LeadScoringDecayWorker — Automated daily score decay.
 *
 * Runs nightly at 03:00 AM.
 * Scans contacts who haven't had any activity in the last 14 days and
 * degrades their score by 10% (or minimum 5 points), floored at 0.
 *
 * Prevents inactive leads from retaining high scores indefinitely.
 */
@Injectable()
export class LeadScoringDecayWorker {
  private readonly logger = new Logger(LeadScoringDecayWorker.name);

  constructor(
    @InjectModel(ContactSchemaClass.name)
    private readonly contactModel: Model<ContactSchemaDocument>,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleScoreDecaySweep() {
    this.logger.log('Starting scheduled Lead Score Decay sweep...');

    const INACTIVITY_THRESHOLD_DAYS = 14;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - INACTIVITY_THRESHOLD_DAYS);

    const PAGE = 1_000;
    let after: Types.ObjectId | undefined;
    let totalDecayed = 0;

    for (;;) {
      const page = await this.contactModel
        .find({
          score: { $gt: 0 },
          deletedAt: null,
          $or: [
            { lastActivityAt: { $lt: cutoffDate } },
            { lastActivityAt: null, createdAt: { $lt: cutoffDate } },
          ],
          ...(after ? { _id: { $gt: after } } : {}),
        })
        .setOptions({ isPlatformQuery: true } as any)
        .sort({ _id: 1 })
        .limit(PAGE)
        .lean()
        .exec();

      if (page.length === 0) break;

      const bulkOps = page.map((contact) => {
        const currentScore = contact.score ?? 0;
        // Deduct 10% or at least 5 points
        const decayAmount = Math.max(5, Math.floor(currentScore * 0.1));
        const newScore = Math.max(0, currentScore - decayAmount);

        return {
          updateOne: {
            filter: { _id: contact._id },
            update: { $set: { score: newScore } },
          },
        };
      });

      if (bulkOps.length > 0) {
        const res = await this.contactModel.bulkWrite(bulkOps as any, {
          ordered: false,
        });
        totalDecayed += res.modifiedCount;
      }

      after = page[page.length - 1]._id as unknown as Types.ObjectId;
      if (page.length < PAGE) break;
    }

    this.logger.log(
      `Lead Score Decay sweep completed. Applied decay to ${totalDecayed} inactive contacts.`,
    );
  }
}
