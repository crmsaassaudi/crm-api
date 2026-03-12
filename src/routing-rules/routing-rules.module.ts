import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RoutingRulesController } from './routing-rules.controller';
import { RoutingRulesService } from './routing-rules.service';
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
  providers: [RoutingRulesService, RoutingRuleRepository],
  exports: [RoutingRulesService],
})
export class RoutingRulesModule {}
