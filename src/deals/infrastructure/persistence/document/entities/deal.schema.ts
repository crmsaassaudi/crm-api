import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type DealSchemaDocument = HydratedDocument<DealSchemaClass>;

@Schema({
    timestamps: true,
    collection: 'deals',
    toJSON: {
        virtuals: true,
        getters: true,
    },
})
export class DealSchemaClass extends EntityDocumentHelper {
    @Prop({ type: String, ref: 'TenantSchemaClass', required: true, index: true })
    tenant: string;

    @Prop({ required: true, index: true })
    name: string;

    @Prop({ default: 0 })
    amount: number;

    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'ContactSchemaClass', required: true })
    contact: string;

    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'AccountSchemaClass' })
    account?: string;

    @Prop({ required: true })
    stage: string;

    @Prop({ required: true })
    pipeline: string;

    @Prop()
    closingDate?: Date;

    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
    owner?: string;

    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass', required: true })
    createdBy: string;

    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass', required: true })
    updatedBy: string;

    @Prop({ default: now })
    createdAt: Date;

    @Prop({ default: now })
    updatedAt: Date;

    @Prop()
    deletedAt?: Date;
}

export const DealSchema = SchemaFactory.createForClass(DealSchemaClass);

DealSchema.plugin(tenantFilterPlugin, { field: 'tenant' });
