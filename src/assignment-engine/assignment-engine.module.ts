import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AssignmentEngineController } from './assignment-engine.controller';
import { AssignmentEngineService } from './assignment-engine.service';

// Sub-services
import { CapacityFilterService } from './services/capacity-filter.service';
import { StrategyExecutorService } from './services/strategy-executor.service';
import { FallbackResolverService } from './services/fallback-resolver.service';
import { RuleEvaluatorService } from './services/rule-evaluator.service';
import { AssignmentAuditService } from './services/assignment-audit.service';

// Schemas
import {
  AssignmentRuleSchemaClass,
  AssignmentRuleSchema,
} from './entities/assignment-rule.schema';
import {
  AssignmentSettingSchemaClass,
  AssignmentSettingSchema,
} from './entities/assignment-setting.schema';
import {
  AssignmentAuditLogSchemaClass,
  AssignmentAuditLogSchema,
} from './entities/assignment-audit-log.schema';
import {
  AssignmentSkillSchemaClass,
  AssignmentSkillSchema,
} from './entities/assignment-skill.schema';

// External schemas needed for group resolution
import {
  GroupSchemaClass,
  GroupSchema,
} from '../groups/infrastructure/persistence/document/entities/group.schema';

// Phase 3.3: AgentPresenceService injected directly to avoid circular dep
// (importing OmniInboundModule triggers ChannelsModule → LivechatModule cycle).
// AgentPresenceService only depends on Redis (globally available) — safe to
// instantiate independently.
import { AgentPresenceService } from '../omni-inbound/services/agent-presence.service';
import { CrmSettingsModule } from '../crm-settings/crm-settings.module';

@Module({
  imports: [
    CrmSettingsModule,
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
  controllers: [AssignmentEngineController],
  providers: [
    AssignmentEngineService,
    CapacityFilterService,
    StrategyExecutorService,
    FallbackResolverService,
    RuleEvaluatorService,
    AssignmentAuditService,
    // Phase 3.3: AgentPresenceService provided directly (Redis-only deps)
    AgentPresenceService,
  ],
  exports: [AssignmentEngineService],
})
export class AssignmentEngineModule {}
