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
   */
  async confirm(alias: string): Promise<void> {
    await this.model.updateOne(
      { alias },
      { $set: { status: AliasReservationStatus.CONFIRMED } },
    );
  }

  /**
   * Deletes a reservation. Called during Saga rollback.
   */
  async delete(alias: string): Promise<void> {
    await this.model.deleteOne({ alias });
  }
}
