import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type IntegrationLogDocument = HydratedDocument<IntegrationLog>;

@Schema({ timestamps: true })
export class IntegrationLog {
    @Prop({ required: true, index: true })
    service: string;

    @Prop({ required: true })
    url: string;

    @Prop({ required: true })
    method: string;

    @Prop({ required: true })
    status: number;

    @Prop({ required: true, index: true })
    success: boolean;

    @Prop({ default: 0 })
    retries: number;

    @Prop({ default: false })
    breakerOpen: boolean;

    @Prop({ required: true })
    durationMs: number;

    @Prop({ index: true })
    correlationId: string;
}

export const IntegrationLogSchema = SchemaFactory.createForClass(IntegrationLog);
