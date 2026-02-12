import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { now, HydratedDocument } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';

export type TenantSchemaDocument = HydratedDocument<TenantSchemaClass>;

@Schema({
    timestamps: true,
    toJSON: {
        virtuals: true,
        getters: true,
        transform: (doc, ret: any) => {
            delete ret._id;
            delete ret.__v;
            return ret;
        },
    },
})
export class TenantSchemaClass extends EntityDocumentHelper {
    @Prop({ required: true })
    name: string;

    @Prop({ required: true, unique: true })
    domain: string;

    @Prop({ default: now })
    createdAt: Date;

    @Prop({ default: now })
    updatedAt: Date;

    @Prop()
    deletedAt: Date;
}

export const TenantSchema = SchemaFactory.createForClass(TenantSchemaClass);
