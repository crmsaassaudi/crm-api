import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';

export type FolderSchemaDocument = HydratedDocument<FolderSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'folders',
  toJSON: {
    virtuals: true,
    getters: true,
  },
})
export class FolderSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true })
  name: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'FolderSchemaClass',
    default: null,
  })
  parentId: string | null;

  @Prop({ required: true })
  path: string;

  @Prop({ default: 0 })
  depth: number;

  @Prop({ required: true })
  createdBy: string;

  @Prop()
  color?: string;

  @Prop({ default: false })
  isDeleted?: boolean;

  @Prop()
  deletedAt?: Date;
}

export const FolderSchema = SchemaFactory.createForClass(FolderSchemaClass);

// List children of a folder
FolderSchema.index(
  { tenantId: 1, parentId: 1, isDeleted: 1 },
  { background: true },
);

// Unique path per tenant
FolderSchema.index(
  { tenantId: 1, path: 1 },
  { background: true, unique: true },
);

// Find by name within parent (for duplicate name check)
FolderSchema.index(
  { tenantId: 1, parentId: 1, name: 1, isDeleted: 1 },
  { background: true },
);
