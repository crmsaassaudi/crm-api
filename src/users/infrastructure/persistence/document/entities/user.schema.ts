import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { now, HydratedDocument, Schema as MongooseSchema } from 'mongoose';

import { AuthProvidersEnum } from '../../../../../auth/auth-providers.enum';
import { FileSchemaClass } from '../../../../../files/infrastructure/persistence/document/entities/file.schema';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { PlatformRoleEnum } from '../../../../../roles/platform-role.enum';
import { StatusEnum } from '../../../../../statuses/statuses.enum';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type UserSchemaDocument = HydratedDocument<UserSchemaClass>;

@Schema({
  timestamps: true,
  optimisticConcurrency: true,
  versionKey: '__v',
  collection: 'users',
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
export class UserSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: [
      {
        tenant: { type: MongooseSchema.Types.ObjectId, ref: 'TenantSchemaClass' },
        roles: [String],
        joinedAt: { type: Date, default: now },
      },
    ],
    default: [],
  })
  tenants: {
    tenant: string;
    roles: string[];
    joinedAt: Date;
  }[];

  @Prop({
    type: String,
    unique: false,
  })
  email: string | null;

  @Prop()
  password?: string;

  @Prop({
    default: AuthProvidersEnum.email,
  })
  provider: string;

  @Prop({
    type: String,
    default: null,
  })
  keycloakId?: string | null;

  @Prop({
    type: String,
  })
  firstName: string | null;

  @Prop({
    type: String,
  })
  lastName: string | null;

  @Prop({
    type: FileSchemaClass,
  })
  photo?: FileSchemaClass | null;

  @Prop({
    type: String,
    enum: Object.values(PlatformRoleEnum),
    default: PlatformRoleEnum.USER,
  })
  platformRole?: string | null;

  @Prop({
    type: String,
    enum: Object.values(StatusEnum),
    default: null,
  })
  status?: string | null;

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;

  @Prop()
  deletedAt: Date;
}

export const UserSchema = SchemaFactory.createForClass(UserSchemaClass);

UserSchema.plugin(tenantFilterPlugin, { field: 'tenants.tenant' });

UserSchema.index({ platformRole: 1 });
UserSchema.index({ email: 1, tenant: 1 }, { unique: true });
