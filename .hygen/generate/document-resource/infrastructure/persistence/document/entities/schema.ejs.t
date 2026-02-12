---
to: src/<%= h.inflection.transform(name, ['pluralize', 'underscore', 'dasherize']) %>/infrastructure/persistence/document/entities/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.schema.ts
---
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';

export type <%= name %>SchemaDocument = HydratedDocument<<%= name %>SchemaClass>;

@Schema({
  timestamps: true,
  optimisticConcurrency: true, // BẮT BUỘC: Bật cơ chế check version
  versionKey: '__v',           // BẮT BUỘC: Giữ nguyên key gốc
  collection: '<%= h.inflection.transform(name, ["pluralize", "underscore"]) %>',
})
export class <%= name %>SchemaClass extends EntityDocumentHelper {
  // KHÔNG khai báo @Prop() version: number ở đây!
  // Để Mongoose tự động quản lý __v ngầm.
  
  // Các trường khác...
  @Prop({ required: true })
  tenantId: string;
}

export const <%= name %>Schema = SchemaFactory.createForClass(<%= name %>SchemaClass);
