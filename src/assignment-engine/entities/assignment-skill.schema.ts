import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type AssignmentSkillDocument =
  HydratedDocument<AssignmentSkillSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'assignment_skills',
  toJSON: { virtuals: true, getters: true },
})
export class AssignmentSkillSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  apiName: string;

  @Prop()
  category?: string;
}

export const AssignmentSkillSchema = SchemaFactory.createForClass(
  AssignmentSkillSchemaClass,
);
AssignmentSkillSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
AssignmentSkillSchema.index({ tenantId: 1, apiName: 1 }, { unique: true });
