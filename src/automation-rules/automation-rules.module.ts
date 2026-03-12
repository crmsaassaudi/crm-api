import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AutomationRulesController } from './automation-rules.controller';
import { AutomationRulesService } from './automation-rules.service';
import { AutomationRuleRepository } from './infrastructure/persistence/document/repositories/automation-rule.repository';
import {
  AutomationRuleSchema,
  AutomationRuleSchemaClass,
} from './infrastructure/persistence/document/entities/automation-rule.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AutomationRuleSchemaClass.name, schema: AutomationRuleSchema },
    ]),
  ],
  controllers: [AutomationRulesController],
  providers: [AutomationRulesService, AutomationRuleRepository],
  exports: [AutomationRulesService],
})
export class AutomationRulesModule {}
