import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

// Schemas
// NOTE: the legacy `automation_rules` collection is intentionally NOT registered
// here. It was a CRUD-only feature with no evaluator anywhere in the codebase —
// tenants could author rules that could never run. Removed 2026-07-28; the
// collection itself is left in place so historical rows are not destroyed.
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
import {
  AutomationDelayedJobSchema,
  AutomationDelayedJobSchemaClass,
} from './infrastructure/persistence/document/entities/automation-delayed-job.schema';

// Repositories
import { AutomationWorkflowRepository } from './infrastructure/persistence/document/repositories/automation-workflow.repository';
import { AutomationExecutionLogRepository } from './infrastructure/persistence/document/repositories/automation-execution-log.repository';
import { AutomationAuditLogRepository } from './infrastructure/persistence/document/repositories/automation-audit-log.repository';
import { AutomationDelayedJobRepository } from './infrastructure/persistence/document/repositories/automation-delayed-job.repository';

// Controllers & Services
import { AutomationWorkflowController } from './automation-workflow.controller';
import { AutomationWorkflowService } from './automation-workflow.service';
import { AutomationExecutionLogController } from './automation-execution-log.controller';
import { AutomationAuditService } from './automation-audit.service';

// Engine
import { AutomationEventListenerService } from './events/automation-event-listener.service';
import { AutomationOutboxModule } from './events/automation-outbox.module';
import { OmniAutomationBridgeService } from './events/omni-automation-bridge.service';
import { ConditionEvaluatorService } from './engine/condition-evaluator.service';
import { LoopPreventionService } from './engine/loop-prevention.service';
import { WorkflowOrchestratorService } from './engine/workflow-orchestrator.service';
import { BulkEventThrottleService } from './engine/bulk-event-throttle.service';
import { TemplateInterpolationService } from './engine/template-interpolation.service';
import { CrmRecordUpdateService } from './engine/crm-record-update.service';
import { SsrfGuardService } from '../common/http/ssrf-guard.service';
import { WebhookHeaderCryptoService } from './engine/webhook-header-crypto.service';
import { ScheduledTriggerService } from './engine/scheduled-trigger.service';
import { ActionIdempotencyService } from './engine/action-idempotency.service';
import { TriggerEvaluatorService } from './engine/trigger-evaluator.service';
import { ExecutionContextService } from './engine/execution-context.service';
import {
  AutomationAssigneeResolver,
  SendEmailExecutor,
  SendSmsExecutor,
  UpdateFieldExecutor,
  RouteToGroupExecutor,
  WebhookExecutor,
  CreateTaskExecutor,
  CreateTicketExecutor,
  AddTagExecutor,
  RemoveTagExecutor,
  AddNoteExecutor,
  CreateRecordExecutor,
  HttpRequestExecutor,
  SendWhatsAppExecutor,
  SendZnsExecutor,
  SendLivechatExecutor,
  InternalNotificationExecutor,
} from './engine/action-executors';

// Providers (Email + SMS)
import {
  SendGridEmailProvider,
  EMAIL_PROVIDER_TOKEN,
} from './engine/providers/email-provider.service';
import {
  TwilioSmsProvider,
  SMS_PROVIDER_TOKEN,
} from './engine/providers/sms-provider.service';

// Queue
import { AutomationQueueModule } from './queue/automation-queue.module';
import { AutomationActionProducer } from './queue/automation-action.producer';
import { AutomationTriggerProcessor } from './queue/automation-trigger.processor';
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
import { AutomationDelayedScheduler } from './queue/automation-delayed.scheduler';

// CRM Modules (for real action executors)
import { ContactsModule } from '../contacts/contacts.module';
import { TicketsModule } from '../tickets/tickets.module';
import { DealsModule } from '../deals/deals.module';
import { AccountsModule } from '../accounts/accounts.module';
import { TasksModule } from '../tasks/tasks.module';
import { ChannelsModule } from '../channels/channels.module';
import { NotesModule } from '../notes/notes.module';
import { isWorkerRuntime } from '../config/runtime-role';
import { ObservabilityModule } from '../observability/observability.module';
import {
  TicketSchemaClass,
  TicketSchema,
} from '../tickets/infrastructure/persistence/document/entities/ticket.schema';
import {
  DealSchemaClass,
  DealSchema,
} from '../deals/infrastructure/persistence/document/entities/deal.schema';

const workerProviders = isWorkerRuntime()
  ? [
      AutomationActionProcessor,
      AutomationEmailProcessor,
      AutomationSmsProcessor,
      AutomationInternalProcessor,
      AutomationWebhookProcessor,
      AutomationDlqProcessor,
      AutomationBulkProcessor,
      AutomationDelayedProcessor,
      AutomationDelayedScheduler,
      AutomationTriggerProcessor,
    ]
  : [];

@Module({
  imports: [
    MongooseModule.forFeature([
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
      {
        name: AutomationDelayedJobSchemaClass.name,
        schema: AutomationDelayedJobSchema,
      },
      { name: TicketSchemaClass.name, schema: TicketSchema },
      { name: DealSchemaClass.name, schema: DealSchema },
    ]),
    AutomationQueueModule,
    AutomationOutboxModule,
    // MetricsService — throttle fail-open / engagement counters
    ObservabilityModule,
    // CRM modules — needed by CrmRecordUpdateService for real DB updates
    forwardRef(() => ContactsModule),
    forwardRef(() => TicketsModule),
    forwardRef(() => DealsModule),
    forwardRef(() => AccountsModule),
    forwardRef(() => TasksModule),
    // Channel Config — needed by SendEmailExecutor/SendSmsExecutor for dynamic credentials
    forwardRef(() => ChannelsModule),
    // Notes — needed by AddNoteExecutor for contact notes
    forwardRef(() => NotesModule),
  ],
  controllers: [AutomationWorkflowController, AutomationExecutionLogController],
  providers: [
    // Services
    AutomationWorkflowService,
    AutomationAuditService,
    // Repositories
    AutomationWorkflowRepository,
    AutomationExecutionLogRepository,
    AutomationAuditLogRepository,
    AutomationDelayedJobRepository,
    // Engine — core
    AutomationEventListenerService,
    OmniAutomationBridgeService,
    ConditionEvaluatorService,
    LoopPreventionService,
    WorkflowOrchestratorService,
    BulkEventThrottleService,
    // Engine — Phase 4 services
    TemplateInterpolationService,
    CrmRecordUpdateService,
    SsrfGuardService,
    WebhookHeaderCryptoService,
    // Exactly-once guard for action jobs
    ActionIdempotencyService,
    // Establishes the principal + data-visibility axes for an execution
    ExecutionContextService,
    // Trigger matching, moved out of the event listener
    TriggerEvaluatorService,
    // Eligibility gate shared by the record-creating executors
    AutomationAssigneeResolver,
    // Action Executors (all 15 types)
    SendEmailExecutor,
    SendSmsExecutor,
    UpdateFieldExecutor,
    RouteToGroupExecutor,
    WebhookExecutor,
    CreateTaskExecutor,
    CreateTicketExecutor,
    AddTagExecutor,
    RemoveTagExecutor,
    AddNoteExecutor,
    CreateRecordExecutor,
    HttpRequestExecutor,
    SendWhatsAppExecutor,
    SendZnsExecutor,
    SendLivechatExecutor,
    InternalNotificationExecutor,
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
    AutomationDlqProducer,
    AutomationBulkProducer,
    AutomationDelayedProducer,
    ...workerProviders,
    // Time-based automation trigger (cron)
    ScheduledTriggerService,
  ],
  exports: [
    AutomationWorkflowService,
    AutomationWorkflowRepository,
    AutomationExecutionLogRepository,
    AutomationDelayedJobRepository,
    ConditionEvaluatorService,
    WorkflowOrchestratorService,
    TemplateInterpolationService,
    CrmRecordUpdateService,
  ],
})
export class AutomationRulesModule {}
