import { Module, forwardRef } from '@nestjs/common';
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
import {
  AutomationAuditLogSchema,
  AutomationAuditLogSchemaClass,
} from './infrastructure/persistence/document/entities/automation-audit-log.schema';

// ── Repositories ─────────────────────────────────────────────────────────
import { AutomationRuleRepository } from './infrastructure/persistence/document/repositories/automation-rule.repository';
import { AutomationWorkflowRepository } from './infrastructure/persistence/document/repositories/automation-workflow.repository';
import { AutomationExecutionLogRepository } from './infrastructure/persistence/document/repositories/automation-execution-log.repository';
import { AutomationAuditLogRepository } from './infrastructure/persistence/document/repositories/automation-audit-log.repository';

// ── Controllers & Services ───────────────────────────────────────────────
import { AutomationRulesController } from './automation-rules.controller';
import { AutomationRulesService } from './automation-rules.service';
import { AutomationWorkflowController } from './automation-workflow.controller';
import { AutomationWorkflowService } from './automation-workflow.service';
import { AutomationExecutionLogController } from './automation-execution-log.controller';
import { AutomationAuditService } from './automation-audit.service';

// ── Engine ───────────────────────────────────────────────────────────────
import { AutomationEventListenerService } from './events/automation-event-listener.service';
import { ConditionEvaluatorService } from './engine/condition-evaluator.service';
import { LoopPreventionService } from './engine/loop-prevention.service';
import { WorkflowOrchestratorService } from './engine/workflow-orchestrator.service';
import { BulkEventThrottleService } from './engine/bulk-event-throttle.service';
import { TemplateInterpolationService } from './engine/template-interpolation.service';
import { CrmRecordUpdateService } from './engine/crm-record-update.service';
import { SsrfGuardService } from './engine/ssrf-guard.service';
import {
  SendEmailExecutor,
  SendSmsExecutor,
  UpdateFieldExecutor,
  RouteToTeamExecutor,
  WebhookExecutor,
} from './engine/action-executors';

// ── Providers (Email + SMS) ─────────────────────────────────────────────
import {
  SendGridEmailProvider,
  EMAIL_PROVIDER_TOKEN,
} from './engine/providers/email-provider.service';
import {
  TwilioSmsProvider,
  SMS_PROVIDER_TOKEN,
} from './engine/providers/sms-provider.service';

// ── Queue ────────────────────────────────────────────────────────────────
import { AutomationQueueModule } from './queue/automation-queue.module';
import { AutomationActionProducer } from './queue/automation-action.producer';
import {
  AutomationActionProcessor,
  AutomationEmailProcessor,
  AutomationSmsProcessor,
  AutomationInternalProcessor,
  AutomationWebhookProcessor,
} from './queue/automation-action.processor';
import { AutomationDlqProducer } from './queue/automation-dlq.producer';
import { AutomationDlqProcessor } from './queue/automation-dlq.processor';
import { AutomationBulkProducer } from './queue/automation-bulk.producer';
import { AutomationBulkProcessor } from './queue/automation-bulk.processor';
import { AutomationDelayedProducer } from './queue/automation-delayed.producer';
import { AutomationDelayedProcessor } from './queue/automation-delayed.processor';

// ── CRM Modules (for real action executors) ──────────────────────────────
import { ContactsModule } from '../contacts/contacts.module';
import { TicketsModule } from '../tickets/tickets.module';
import { DealsModule } from '../deals/deals.module';
import { AccountsModule } from '../accounts/accounts.module';
import { TasksModule } from '../tasks/tasks.module';
import { AssignmentEngineModule } from '../assignment-engine/assignment-engine.module';
import { ChannelsModule } from '../channels/channels.module';

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
      {
        name: AutomationAuditLogSchemaClass.name,
        schema: AutomationAuditLogSchema,
      },
    ]),
    AutomationQueueModule,
    // CRM modules — needed by CrmRecordUpdateService for real DB updates
    forwardRef(() => ContactsModule),
    forwardRef(() => TicketsModule),
    forwardRef(() => DealsModule),
    forwardRef(() => AccountsModule),
    forwardRef(() => TasksModule),
    forwardRef(() => AssignmentEngineModule),
    // Channel Config — needed by SendEmailExecutor/SendSmsExecutor for dynamic credentials
    forwardRef(() => ChannelsModule),
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
    AutomationAuditService,
    // Repositories
    AutomationRuleRepository,
    AutomationWorkflowRepository,
    AutomationExecutionLogRepository,
    AutomationAuditLogRepository,
    // Engine — core
    AutomationEventListenerService,
    ConditionEvaluatorService,
    LoopPreventionService,
    WorkflowOrchestratorService,
    BulkEventThrottleService,
    // Engine — Phase 4 services
    TemplateInterpolationService,
    CrmRecordUpdateService,
    SsrfGuardService,
    // Action Executors (all 5 types)
    SendEmailExecutor,
    SendSmsExecutor,
    UpdateFieldExecutor,
    RouteToTeamExecutor,
    WebhookExecutor,
    // Email Provider (SendGrid — dry-run if no API key)
    {
      provide: EMAIL_PROVIDER_TOKEN,
      useClass: SendGridEmailProvider,
    },
    // SMS Provider (Twilio — dry-run if no credentials)
    {
      provide: SMS_PROVIDER_TOKEN,
      useClass: TwilioSmsProvider,
    },
    // Queue — Producers & Processors
    AutomationActionProducer,
    AutomationActionProcessor,
    AutomationEmailProcessor,
    AutomationSmsProcessor,
    AutomationInternalProcessor,
    AutomationWebhookProcessor,
    AutomationDlqProducer,
    AutomationDlqProcessor,
    AutomationBulkProducer,
    AutomationBulkProcessor,
    AutomationDelayedProducer,
    AutomationDelayedProcessor,
  ],
  exports: [
    AutomationRulesService,
    AutomationWorkflowService,
    AutomationWorkflowRepository,
    AutomationExecutionLogRepository,
    ConditionEvaluatorService,
    WorkflowOrchestratorService,
    TemplateInterpolationService,
    CrmRecordUpdateService,
  ],
})
export class AutomationRulesModule {}
