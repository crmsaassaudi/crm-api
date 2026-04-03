---
to: src/<%= h.inflection.transform(name, ['pluralize', 'underscore', 'dasherize']) %>/infrastructure/persistence/document/entities/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.schema.ts
---
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type <%= name %>SchemaDocument = HydratedDocument<<%= name %>SchemaClass>;

@Schema({
  timestamps: true,
  optimisticConcurrency: true,
  versionKey: '__v',
  collection: '<%= h.inflection.transform(name, ["pluralize", "underscore"]) %>',
  toJSON: {
    virtuals: true,
    getters: true,
    transform: (doc, ret: any) => {
      ret.version = ret.__v;
      delete ret.__v;
      return ret;
    },
  },
})
export class <%= name %>SchemaClass extends EntityDocumentHelper {
  // ── Multitenant fields (auto-injected by BaseDocumentRepository) ──

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'TenantSchemaClass', required: true, index: true })
  tenantId: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass', required: true })
  createdById: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass', required: true })
  updatedById: string;

  // ── Resource-specific fields ──
  // Do not remove comment below.
  // <schema-property />

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;

  @Prop()
  deletedAt?: Date;
}

export const <%= name %>Schema = SchemaFactory.createForClass(<%= name %>SchemaClass);

// Auto-apply tenant filtering on all queries
<%= name %>Schema.plugin(tenantFilterPlugin, { field: 'tenantId' });
<%= name %>Schema.index({ tenantId: 1 });
