import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { SubscriptionPlan, TenantStatus } from '../../../../domain/tenant';

export type TenantSchemaDocument = HydratedDocument<TenantSchemaClass>;

@Schema({
    timestamps: true,
    optimisticConcurrency: true,
    versionKey: '__v',
    collection: 'tenants',
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
export class TenantSchemaClass extends EntityDocumentHelper {
    @Prop({ required: true, unique: true, index: true })
    keycloakOrgId: string;

    @Prop({ required: true, unique: true, index: true })
    alias: string;

    @Prop({ required: true })
    name: string;

    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass', index: true })
    owner: Types.ObjectId | null;

    @Prop({
        type: String,
        enum: Object.values(SubscriptionPlan),
        default: SubscriptionPlan.FREE,
    })
    subscriptionPlan: SubscriptionPlan;

    @Prop({
        type: String,
        enum: Object.values(TenantStatus),
        default: TenantStatus.ACTIVE,
    })
    status: TenantStatus;

    @Prop()
    createdAt: Date;

    @Prop()
    updatedAt: Date;
}

export const TenantSchema = SchemaFactory.createForClass(TenantSchemaClass);
