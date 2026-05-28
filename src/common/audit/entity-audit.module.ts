import { Global, Module } from '@nestjs/common';
import { EntityAuditService } from './entity-audit.service';

/**
 * Global module so any service can inject `EntityAuditService` without
 * each feature module re-declaring providers.
 *
 * EventEmitterModule (already configured in AppModule) and ClsModule must
 * be available at the app root — they are.
 */
@Global()
@Module({
  providers: [EntityAuditService],
  exports: [EntityAuditService],
})
export class EntityAuditModule {}
