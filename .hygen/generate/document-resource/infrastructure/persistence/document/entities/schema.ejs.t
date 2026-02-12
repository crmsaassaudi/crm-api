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
  versionKey: '__v', // Giữ nguyên key gốc
  collection: '<%= h.inflection.transform(name, ["pluralize", "underscore"]) %>',
  toJSON: {
    virtuals: true,
    getters: true,
    transform: (doc, ret: any) => {
      ret.version = ret.__v; // Map __v -> version
      delete ret.__v; // Ẩn __v
      return ret;
    },
  },
})
export class <%= name %>SchemaClass extends EntityDocumentHelper {
  @Prop({ required: true, index: true })
  tenantId: string;

  // Không khai báo @Prop version ở đây
}

export const <%= name %>Schema = SchemaFactory.createForClass(<%= name %>SchemaClass);
