---
to: src/<%= h.inflection.transform(name, ['pluralize', 'underscore', 'dasherize']) %>/infrastructure/persistence/document/entities/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.schema.ts
---
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';

export type <%= name %>SchemaDocument = HydratedDocument<<%= name %>SchemaClass>;

@Schema({
  timestamps: true,
  optimisticConcurrency: true,
  versionKey: 'version',
  toJSON: {
    virtuals: true,
    getters: true,
  },
})
export class <%= name %>SchemaClass extends EntityDocumentHelper {
  @Prop({ type: Number })
  version: number;
}

export const <%= name %>Schema = SchemaFactory.createForClass(<%= name %>SchemaClass);
