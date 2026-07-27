import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  AssignmentRuleSchema,
  AssignmentRuleSchemaClass,
} from './infrastructure/persistence/assignment-rule.schema';
import {
  AssignmentSettingSchema,
  AssignmentSettingSchemaClass,
} from './infrastructure/persistence/assignment-setting.schema';
import {
  AssignmentAuditLogSchema,
  AssignmentAuditLogSchemaClass,
} from './infrastructure/persistence/assignment-audit-log.schema';
import {
  AssignmentSkillSchema,
  AssignmentSkillSchemaClass,
} from './infrastructure/persistence/assignment-skill.schema';
import {
  GroupSchema,
  GroupSchemaClass,
} from '../groups/infrastructure/persistence/document/entities/group.schema';

import { AssignmentRuleRepository } from './infrastructure/persistence/assignment-rule.repository';
import { AssignmentAuditLogRepository } from './infrastructure/persistence/assignment-audit-log.repository';
import { RoundRobinCursorService } from './infrastructure/reservation/round-robin-cursor.service';
import { ZsetReservationService } from './infrastructure/reservation/zset-reservation.service';

import { AssignmentConfigService } from './core/assignment-config.service';
import { AssignmentRuleEvaluatorService } from './core/rule-evaluator.service';
import { AssignmentCoreService } from './core/assignment-core.service';
import { ASSIGNMENT_ADAPTER } from './core/ports';

import { RecordCandidatePort } from './adapters/record/record-candidate.port';
import { RecordLoadPort } from './adapters/record/record-load.port';
import { RecordCommitPort } from './adapters/record/record-commit.port';
import { RecordAssignmentAdapter } from './adapters/record/record-assignment.adapter';

import { AssignmentController } from './api/assignment.controller';
import { AssignmentAdminService } from './api/assignment-admin.service';
import { AssignmentSeederService } from './assignment-seeder.service';

/**
 * The assignment core.
 *
 * `@Global` on purpose: the decision service is a leaf dependency for
 * omni-inbound, automation-rules and every CRM module that can auto-assign, and
 * several of those already sit in import cycles with each other. Making it
 * global means none of them needs an `imports` edge — which is how the previous
 * arrangement ended up with `forwardRef` chains and a `moduleRef.get(..., {
 * strict: false })` lookup at runtime.
 *
 * The record adapter is registered here. The conversation adapter is registered
 * late, from OmniInboundModule, because it depends on presence, channel support
 * and the conversation repository — pulling those in here would recreate the
 * cycle this module exists to avoid.
 */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AssignmentRuleSchemaClass.name, schema: AssignmentRuleSchema },
      {
        name: AssignmentSettingSchemaClass.name,
        schema: AssignmentSettingSchema,
      },
      {
        name: AssignmentAuditLogSchemaClass.name,
        schema: AssignmentAuditLogSchema,
      },
      { name: AssignmentSkillSchemaClass.name, schema: AssignmentSkillSchema },
      { name: GroupSchemaClass.name, schema: GroupSchema },
    ]),
  ],
  controllers: [AssignmentController],
  providers: [
    // Persistence
    AssignmentRuleRepository,
    AssignmentAuditLogRepository,
    // Reservation
    RoundRobinCursorService,
    ZsetReservationService,
    // Core
    AssignmentConfigService,
    AssignmentRuleEvaluatorService,
    AssignmentCoreService,
    // Admin API
    AssignmentAdminService,
    AssignmentSeederService,
    // Record adapter. The presence layer it needs is injected at runtime by
    // OmniInboundModule (RecordCandidatePort.setPresenceProvider) rather than
    // provided here: a second AgentPresenceService instance would run its
    // event handlers twice.
    RecordCandidatePort,
    RecordLoadPort,
    RecordCommitPort,
    RecordAssignmentAdapter,
    {
      provide: ASSIGNMENT_ADAPTER,
      useFactory: (record: RecordAssignmentAdapter) => [record],
      inject: [RecordAssignmentAdapter],
    },
  ],
  exports: [
    AssignmentCoreService,
    RecordCandidatePort,
    AssignmentSeederService,
    AssignmentConfigService,
    AssignmentRuleEvaluatorService,
    AssignmentRuleRepository,
    AssignmentAuditLogRepository,
    ZsetReservationService,
    RoundRobinCursorService,
  ],
})
export class AssignmentModule {}
