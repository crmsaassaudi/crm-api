import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditLogService } from './audit-log.service';
import {
  AuditLogSchema,
  AuditLogSchemaClass,
} from './entities/audit-log.schema';
import { AuditLogListener } from './listeners/audit-log.listener';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AuditLogSchemaClass.name, schema: AuditLogSchema },
    ]),
  ],
  providers: [AuditLogService, AuditLogListener],
  exports: [AuditLogService],
})
export class AuditLogModule {}
