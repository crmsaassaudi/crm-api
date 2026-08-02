import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AliasReservationStatus,
  TenantAliasReservationDocument,
  TenantAliasReservationSchemaClass,
} from '../entities/tenant-alias-reservation.schema';

const RESERVATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

@Injectable()
export class TenantAliasReservationRepository {
  private readonly logger = new Logger(TenantAliasReservationRepository.name);

  constructor(
    @InjectModel(TenantAliasReservationSchemaClass.name)
    private readonly model: Model<TenantAliasReservationDocument>,
  ) {}

  /**
   * Atomically reserves an alias using MongoDB's unique index constraint.
   * If the alias is already taken (by a CONFIRMED or RESERVED doc), throws ConflictException.
   */
  async reserve(alias: string): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MS);

    try {
      await this.model.create({
        alias,
        status: AliasReservationStatus.RESERVED,
        createdAt: now,
        expiresAt,
      });
    } catch (error: any) {
      // MongoDB duplicate key error code
      if (error?.code === 11000) {
        throw new ConflictException(
          `Organization alias "${alias}" is already taken.`,
        );
      }
      throw error;
    }
  }

  /**
   * Marks a reservation as CONFIRMED once the Saga completes successfully.
   *
   * Upserts rather than updating in place. A plain update silently matched
   * nothing when the reservation had expired or been cleared by an earlier
   * rollback, which left a live tenant whose alias nothing was holding — the
   * next signup could reserve the same name and then fail on the tenants
   * collection's unique index. The confirmed row is the lock, so it has to
   * exist by the time provisioning reports success.
   */
  async confirm(alias: string): Promise<void> {
    await this.model.updateOne(
      { alias },
      {
        $set: { status: AliasReservationStatus.CONFIRMED },
        // The TTL index deletes any document carrying a past `expiresAt`,
        // regardless of status. Leaving it set expired the lock 30 minutes
        // after every successful signup.
        $unset: { expiresAt: '' },
        $setOnInsert: { alias, createdAt: new Date() },
      },
      { upsert: true },
    );
  }

  /**
   * Deletes a reservation. Called during Saga rollback.
   */
  async delete(alias: string): Promise<void> {
    await this.model.deleteOne({ alias });
  }
}
