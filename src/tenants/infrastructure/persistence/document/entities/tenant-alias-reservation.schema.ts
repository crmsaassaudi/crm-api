import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type TenantAliasReservationDocument =
  HydratedDocument<TenantAliasReservationSchemaClass>;

export enum AliasReservationStatus {
  RESERVED = 'RESERVED',
  CONFIRMED = 'CONFIRMED',
}

@Schema({
  collection: 'tenant_alias_reservations',
  timestamps: false,
  toJSON: {
    virtuals: true,
    getters: true,
    transform: (_doc, ret: Record<string, unknown>) => {
      delete ret._id;
      delete ret.__v;
      return ret;
    },
  },
})
export class TenantAliasReservationSchemaClass {
  @Prop({ required: true, unique: true, index: true })
  alias: string;

  @Prop({
    type: String,
    enum: Object.values(AliasReservationStatus),
    default: AliasReservationStatus.RESERVED,
  })
  status: AliasReservationStatus;

  @Prop({ required: true })
  createdAt: Date;

  /**
   * TTL index: Mongo automatically deletes stale RESERVED entries after 30 minutes.
   * This ensures eventual cleanup even if the saga never reaches the rollback handler.
   *
   * Cleared on confirmation, and therefore optional. Mongo's TTL monitor only
   * deletes documents whose indexed field holds a Date, so an absent value is
   * what makes a CONFIRMED reservation permanent. It used to be left in place,
   * which meant the lock on every live tenant's alias expired half an hour
   * after signup and a later signup could reserve a name already in use.
   */
  @Prop({ type: Date, required: false, default: null })
  expiresAt?: Date | null;
}

export const TenantAliasReservationSchema = SchemaFactory.createForClass(
  TenantAliasReservationSchemaClass,
);

// TTL index: auto-expire documents when expiresAt is reached
TenantAliasReservationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
