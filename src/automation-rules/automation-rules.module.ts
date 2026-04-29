import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

// ── Schemas ──────────────────────────────────────────────────────────────
import {
  AutomationRuleSchema,
  AutomationRuleSchemaClass,
} from './infrastructure/persistence/document/entities/automation-rule.schema';
import {
  AutomationWorkflowSchema,
  AutomationWorkflowSchemaClass,
} from './infrastructure/persistence/document/entities/automation-workflow.schema';
import {
  AutomationExecutionLogSchema,
  AutomationExecutionLogSchemaClass,
} from './infrastructure/persistence/document/entities/automation-execution-log.schema';

// ── Repositories ─────────────────────────────────────────────────────────
import { AutomationRuleRepository } from './infrastructure/persistence/document/repositories/automation-rule.repository';
import { AutomationWorkflowRepository } from './infrastructure/persistence/document/repositories/automation-workflow.repository';
import { AutomationExecutionLogRepository } from './infrastructure/persistence/document/repositories/automation-execution-log.repository';

// ── Controllers & Services ───────────────────────────────────────────────
import { AutomationRulesController } from './automation-rules.controller';
import { AutomationRulesService } from './automation-rules.service';
import { AutomationWorkflowController } from './automation-workflow.controller';
import { AutomationWorkflowService } from './automation-workflow.service';
import { AutomationExecutionLogController } from './automation-execution-log.controller';

// ── Engine ───────────────────────────────────────────────────────────────
import { AutomationEventListenerService } from './events/automation-event-listener.service';
import { ConditionEvaluatorService } from './engine/condition-evaluator.service';
import { LoopPreventionService } from './engine/loop-prevention.service';
import { WorkflowOrchestratorService } from './engine/workflow-orchestrator.service';
import {
  SendEmailExecutor,
  SendSmsExecutor,
  UpdateFieldExecutor,
  RouteToTeamExecutor,
} from './engine/action-executors';

// ── Queue ────────────────────────────────────────────────────────────────
import { AutomationQueueModule } from './queue/automation-queue.module';
import { AutomationActionProducer } from './queue/automation-action.producer';
import { AutomationActionProcessor } from './queue/automation-action.processor';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AutomationRuleSchemaClass.name, schema: AutomationRuleSchema },
      {
        name: AutomationWorkflowSchemaClass.name,
        schema: AutomationWorkflowSchema,
      },
      {
        name: AutomationExecutionLogSchemaClass.name,
        schema: AutomationExecutionLogSchema,
      },
    ]),
    AutomationQueueModule,
  ],
  controllers: [
    AutomationRulesController,
    AutomationWorkflowController,
    AutomationExecutionLogController,
  ],
  providers: [
    // Services
    AutomationRulesService,
    AutomationWorkflowService,
    // Repositories
    AutomationRuleRepository,
    AutomationWorkflowRepository,
    AutomationExecutionLogRepository,
    // Engine
    AutomationEventListenerService,
    ConditionEvaluatorService,
    LoopPreventionService,
    WorkflowOrchestratorService,
    // Action Executors (Epic 3)
    SendEmailExecutor,
    SendSmsExecutor,
    UpdateFieldExecutor,
    RouteToTeamExecutor,
    // Queue
    AutomationActionProducer,
    AutomationActionProcessor,
  ],
  exports: [
    AutomationRulesService,
    AutomationWorkflowService,
    AutomationWorkflowRepository,
    AutomationExecutionLogRepository,
    ConditionEvaluatorService,
    WorkflowOrchestratorService,
  ],
})
export class AutomationRulesModule {}
