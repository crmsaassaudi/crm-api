import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../utils/document-entity-helper';

export type AssignmentAuditArchiveDocument =
  HydratedDocument<AssignmentAuditArchiveSchemaClass>;

@Schema({ timestamps: true, collection: 'assignment_audit_archive' })
export class AssignmentAuditArchiveSchemaClass extends EntityDocumentHelper {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  tenantId: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  sourceAuditId: string;

  /** Immutable copy of the complete hot audit row. */
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  envelope: Record<string, any>;

  @Prop({ type: Date, required: true, default: () => new Date() })
  archivedAt: Date;
}

export const AssignmentAuditArchiveSchema = SchemaFactory.createForClass(
  AssignmentAuditArchiveSchemaClass,
);
AssignmentAuditArchiveSchema.index(
  { tenantId: 1, sourceAuditId: 1 },
  { unique: true, name: 'assignment_audit_archive_source_unique' },
);
AssignmentAuditArchiveSchema.index(
  {
    tenantId: 1,
    'envelope.objectType': 1,
    'envelope.entityId': 1,
    archivedAt: -1,
  },
  { name: 'assignment_audit_archive_by_entity' },
);
