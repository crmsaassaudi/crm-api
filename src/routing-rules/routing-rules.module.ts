import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RoutingRulesController } from './routing-rules.controller';
import { RoutingRulesService } from './routing-rules.service';
import { RoutingRuleEvaluatorService } from './routing-rule-evaluator.service';
import { RoutingRuleRepository } from './infrastructure/persistence/document/repositories/routing-rule.repository';
import {
  RoutingRuleSchema,
  RoutingRuleSchemaClass,
} from './infrastructure/persistence/document/entities/routing-rule.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RoutingRuleSchemaClass.name, schema: RoutingRuleSchema },
    ]),
  ],
  controllers: [RoutingRulesController],
  providers: [
    RoutingRulesService,
    RoutingRuleEvaluatorService,
    RoutingRuleRepository,
  ],
  exports: [RoutingRulesService, RoutingRuleEvaluatorService],
})
export class RoutingRulesModule {}
