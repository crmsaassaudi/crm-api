import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AssignmentEngineController } from './assignment-engine.controller';
import { AssignmentEngineService } from './assignment-engine.service';

// Sub-services
import { CapacityFilterService } from './services/capacity-filter.service';
import { StrategyExecutorService } from './services/strategy-executor.service';
import { FallbackResolverService } from './services/fallback-resolver.service';

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
  controllers: [AssignmentEngineController],
  providers: [
    AssignmentEngineService,
    CapacityFilterService,
    StrategyExecutorService,
    FallbackResolverService,
  ],
  exports: [AssignmentEngineService],
})
export class AssignmentEngineModule {}
