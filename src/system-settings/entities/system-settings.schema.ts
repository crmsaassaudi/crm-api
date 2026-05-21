import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SystemSettingsDocument =
  HydratedDocument<SystemSettingsSchemaClass>;

@Schema({
  collection: 'system_settings',
})
export class SystemSettingsSchemaClass {
  @Prop({ type: String, default: 'global', unique: true })
  key: string;

  @Prop({
    type: {
      enabled: { type: Boolean, default: false },
      enabledAt: { type: Date, default: null },
      enabledBy: { type: String, default: null },
      whitelistedIPs: { type: [String], default: [] },
    },
    default: () => ({
      enabled: false,
      enabledAt: null,
      enabledBy: null,
      whitelistedIPs: [],
    }),
  })
  maintenanceMode: {
    enabled: boolean;
    enabledAt: Date | null;
    enabledBy: string | null;
    whitelistedIPs: string[];
  };
}

export const SystemSettingsSchema = SchemaFactory.createForClass(
  SystemSettingsSchemaClass,
);
