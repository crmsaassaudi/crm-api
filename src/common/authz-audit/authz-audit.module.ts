import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  AuthzAuditLogSchemaClass,
  AuthzAuditLogSchema,
} from './authz-audit-log.schema';
import { AuthzAuditService } from './authz-audit.service';
import { AuthzAuditController } from './authz-audit.controller';
import { ObservabilityModule } from '../../observability/observability.module';

/**
 * AuthzAuditModule — append-only authorization-governance audit trail.
 * @Global so any service (roles, groups, users) can record without importing.
 */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AuthzAuditLogSchemaClass.name, schema: AuthzAuditLogSchema },
    ]),
    ObservabilityModule,
  ],
  controllers: [AuthzAuditController],
  providers: [AuthzAuditService],
  exports: [AuthzAuditService],
})
export class AuthzAuditModule {}
