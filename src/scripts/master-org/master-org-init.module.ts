import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import appConfig from '../../config/app.config';
import databaseConfig from '../../database/config/database.config';
import keycloakConfig from '../../auth/config/keycloak.config';
import { MongooseConfigService } from '../../database/mongoose-config.service';
import { KeycloakAdminService } from '../../auth/services/keycloak-admin.service';

import {
  UserSchemaClass,
  UserSchema,
} from '../../users/infrastructure/persistence/document/entities/user.schema';
import {
  TenantSchemaClass,
  TenantSchema,
} from '../../tenants/infrastructure/persistence/document/entities/tenant.schema';
import {
  TenantAliasReservationSchemaClass,
  TenantAliasReservationSchema,
} from '../../tenants/infrastructure/persistence/document/entities/tenant-alias-reservation.schema';

import { MasterOrgInitService } from './master-org-init.service';

const nodeEnv = process.env.NODE_ENV || 'development';
const envFilePath = [
  `.env.${nodeEnv}.local`,
  `.env.${nodeEnv}`,
  '.env.local',
  '.env',
];

/**
 * Minimal standalone module for the master-org bootstrap script. Loads only
 * DB + Keycloak config and the three schemas it touches — deliberately NOT the
 * full AppModule, so running the script does not spin up BullMQ workers,
 * omni consumers, HTTP server, etc.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, appConfig, keycloakConfig],
      envFilePath,
    }),
    MongooseModule.forRootAsync({ useClass: MongooseConfigService }),
    MongooseModule.forFeature([
      { name: UserSchemaClass.name, schema: UserSchema },
      { name: TenantSchemaClass.name, schema: TenantSchema },
      {
        name: TenantAliasReservationSchemaClass.name,
        schema: TenantAliasReservationSchema,
      },
    ]),
  ],
  providers: [KeycloakAdminService, MasterOrgInitService],
})
export class MasterOrgInitModule {}
