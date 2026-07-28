import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../common/plugins/tenant-filter.plugin';
import { ASSIGNMENT_OBJECT_TYPES } from '../../domain/assignment.types';

export type AssignmentPolicyVersionDocument =
  HydratedDocument<AssignmentPolicyVersionSchemaClass>;

@Schema({ timestamps: true, collection: 'assignment_policy_versions' })
export class AssignmentPolicyVersionSchemaClass extends EntityDocumentHelper {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  tenantId: string;

  @Prop({ type: String, enum: ASSIGNMENT_OBJECT_TYPES, required: true })
  objectType: string;

  /** Content-addressed immutable version identifier. */
  @Prop({ type: String, required: true })
  versionId: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  config: Record<string, any>;

  @Prop({ type: [MongooseSchema.Types.Mixed], required: true, default: [] })
  rules: Record<string, any>[];
}

export const AssignmentPolicyVersionSchema = SchemaFactory.createForClass(
  AssignmentPolicyVersionSchemaClass,
);
AssignmentPolicyVersionSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
AssignmentPolicyVersionSchema.index(
  { tenantId: 1, objectType: 1, versionId: 1 },
  { unique: true, name: 'assignment_policy_version_unique' },
);
