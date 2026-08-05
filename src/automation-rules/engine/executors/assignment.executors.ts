import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ActionExecutionResult, ActionExecutor } from './executor.interface';
import { AutomationActionJobData } from '../../queue/automation-queue.constants';
import { TemplateInterpolationService } from '../template-interpolation.service';
import { CrmRecordUpdateService } from '../crm-record-update.service';
import { AssignmentCoreService } from '../../../assignment/core/assignment-core.service';
import { isAssignmentObjectType } from '../../../assignment/domain/assignment.types';
import { AssignmentService } from '../../../omni-inbound/services/assignment.service';
import {
  AGENT_NOT_IN_CHANNEL_POOL,
  GROUP_NOT_IN_CHANNEL_POOL,
} from '../../../channels/services/channel-support.service';
import { TasksService } from '../../../tasks/tasks.service';
import { TicketsService } from '../../../tickets/tickets.service';

// Route to Group / User

@Injectable()
export class RouteToGroupExecutor implements ActionExecutor {
  readonly actionType = 'route_to_group';
  private readonly logger = new Logger(RouteToGroupExecutor.name);

  constructor(
    private readonly assignmentCore: AssignmentCoreService,
    private readonly crmUpdate: CrmRecordUpdateService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordType, actionConfig, tenantId } = job;
    const groupId = actionConfig.groupId;
    const userId = actionConfig.userId;

    if (!groupId && !userId) {
      return {
        success: false,
        retryable: false,
        error: { code: 'NO_TARGET', message: 'groupId or userId is required' },
      };
    }

    // Conversations are not owned via `ownerId` and their assignment has to move
    // presence/capacity state, so they take the omni path rather than the
    // generic CRM field write below.
    if (recordType === 'Conversation') {
      return this.routeConversation(job, groupId, userId);
    }

    if (!isAssignmentObjectType(recordType)) {
      return {
        success: false,
        retryable: false,
        error: {
          code: 'UNSUPPORTED_RECORD_TYPE',
          message: `route_to_group does not support ${recordType}`,
        },
      };
    }

    this.logger.log(
      `[RouteToGroup] tenant=${tenantId} ${recordType}(${recordId}) → group=${groupId ?? 'N/A'} user=${userId ?? 'strategy'}`,
    );

    try {
      /**
       * Commit through CrmRecordUpdateService rather than writing `ownerId`
       * directly, so field-level authorisation, the activity trail and the
       * automation breadcrumbs still apply. The assignment core owns the
       * reservation around this call, so a failed write releases the slot
       * automatically rather than leaving the round-robin cursor and load
       * counter advanced for a record nobody received.
       */
      const commit = async (assigneeId: string): Promise<boolean> => {
        const result = await this.crmUpdate.updateField({
          tenantId,
          recordType,
          recordId,
          field: 'ownerId',
          value: assigneeId,
          sourceWorkflowId: job.sourceWorkflowId,
          automationDepth: job.automationDepth,
          automationBreadcrumbs: job.automationBreadcrumbs,
          allowRestricted: true,
          // route_to_group only ever claims an unowned record — a retried job
          // whose earlier attempt already committed must see the race lost, not
          // overwrite it again with a (possibly different) candidate.
          expectedPreviousValue: null,
        });
        if (!result.success) {
          if (result.raceLost) {
            // Contract with the core: return false rather than throw so the
            // reservation is released cleanly instead of surfacing as an error.
            return false;
          }
          throw new Error(
            result.error ??
              `Failed to set ownerId on ${recordType}(${recordId})`,
          );
        }
        return true;
      };

      /**
       * The configured target is passed to the core. `targetUserId` goes through
       * the same eligibility checks as any other candidate, so pinning a person
       * is not a way around them.
       */
      const decision = await this.assignmentCore.assign({
        tenantId,
        objectType: recordType,
        entityId: recordId,
        attributes: job.recordData,
        targetUserId: userId ?? null,
        targetGroupIds: groupId ? [groupId] : null,
        owningGroupId: groupId ?? null,
        skipRules: true,
        commit,
        source: 'automation',
        sourceWorkflowId: job.sourceWorkflowId ?? null,
        metadata: { actionType: this.actionType },
      });

      if (!decision.assigneeId) {
        return {
          success: false,
          // Neither outcome improves by trying again: nobody is eligible, or
          // auto-assignment is switched off.
          retryable: false,
          error: {
            code:
              decision.outcome === 'skipped'
                ? 'AUTO_ASSIGN_DISABLED'
                : 'NO_ELIGIBLE_AGENT',
            message: decision.reason,
          },
        };
      }

      return {
        success: true,
        output: {
          recordType,
          recordId,
          assignedGroup: decision.groupId,
          assignedUser: decision.assigneeId,
          strategy: decision.strategy,
          reason: decision.reason,
        },
      };
    } catch (error: any) {
      this.logger.error(
        `[RouteToGroup] assignment failed for ${recordType}(${recordId}): ${error.message}`,
        error.stack,
      );
      return {
        success: false,
        error: { code: 'ASSIGNMENT_FAILED', message: error.message },
      };
    }
  }

  /**
   * Assign an omni conversation to a user or group.
   *
   * Delegates to the omni AssignmentService so the assignment goes through the
   * same presence, capacity and channel-support rules as an inbound-triggered
   * one — an automation must not be able to hand a conversation to an agent the
   * channel does not authorize.
   *
   * Resolved lazily: AutomationRulesModule is imported by ChannelsModule (behind
   * a forwardRef), and a static edge to OmniInboundModule — which imports
   * ChannelsModule — would put a queue-owning module inside that cycle.
   */
  private async routeConversation(
    job: AutomationActionJobData,
    groupId: string | undefined,
    userId: string | undefined,
  ): Promise<ActionExecutionResult> {
    const { recordId, tenantId } = job;
    try {
      const assignmentService = this.moduleRef.get(AssignmentService, {
        strict: false,
      });

      const result = await assignmentService.assignConversationExternally(
        tenantId,
        recordId,
        { agentId: userId ?? null, groupId: groupId ?? null },
        `automation:${job.sourceWorkflowId ?? 'rule'}`,
      );

      if (!result.agentId && !result.groupId) {
        return {
          success: false,
          retryable: false,
          error: {
            code: 'NO_ELIGIBLE_AGENT',
            message: `No eligible agent for conversation ${recordId}`,
          },
        };
      }

      this.logger.log(
        `[RouteToGroup] conversation=${recordId} → agent=${result.agentId ?? 'queued'} group=${result.groupId ?? 'none'}`,
      );

      return {
        success: true,
        output: {
          recordType: 'Conversation',
          recordId,
          assignedUser: result.agentId,
          assignedGroup: result.groupId,
          strategy: userId ? 'direct' : 'group',
        },
      };
    } catch (error: any) {
      this.logger.error(
        `[RouteToGroup] conversation assignment failed: ${error.message}`,
        error.stack,
      );
      const poolRejection =
        error?.response?.code === AGENT_NOT_IN_CHANNEL_POOL ||
        error?.response?.code === GROUP_NOT_IN_CHANNEL_POOL;
      return {
        success: false,
        // A pool rejection is a configuration problem, not a transient failure.
        retryable: poolRejection ? false : undefined,
        error: {
          code: poolRejection
            ? 'NOT_IN_CHANNEL_POOL'
            : 'CONVERSATION_ASSIGN_FAILED',
          message: error.message,
        },
      };
    }
  }
}

// Assignee resolution for record-creating actions

/**
 * Validates the assignee/team a `create_task` / `create_ticket` node names,
 * before the record is written. Setting `ownerId` straight from the node config
 * would skip capacity, skills, presence, channel-support pools and even tenant
 * membership — the checks `route_to_group` goes through the core to enforce.
 *
 * A dry-run decision, not a post-create `assign()`: it keeps `ownerId` present at
 * insert time so `RecordAutoAssignmentListener` does not race it, and there is no
 * entity id to reserve against until the record exists. The workload counter is
 * therefore not incremented here — `RecordWorkloadReconciliationService` corrects
 * that.
 */
@Injectable()
export class AutomationAssigneeResolver {
  private readonly logger = new Logger(AutomationAssigneeResolver.name);

  constructor(private readonly assignmentCore: AssignmentCoreService) {}

  async resolve(params: {
    tenantId: string;
    objectType: string;
    assigneeId?: string | null;
    groupId?: string | null;
    attributes: Record<string, any>;
    sourceWorkflowId?: string | null;
    /** Owner inherited from the triggering record when no target is named. */
    fallbackOwnerId?: string | null;
  }): Promise<
    | { ok: true; ownerId: string | null; groupId: string | null }
    | { ok: false; error: { code: string; message: string } }
  > {
    const { assigneeId, groupId } = params;

    // No explicit target: inherit the trigger record's owner, whose eligibility
    // was already established when that record was assigned. With no owner
    // either, leave the record unowned so RecordAutoAssignmentListener picks it
    // up through the normal rules.
    if (!assigneeId && !groupId) {
      return {
        ok: true,
        ownerId: params.fallbackOwnerId ?? null,
        groupId: null,
      };
    }

    if (!isAssignmentObjectType(params.objectType)) {
      return {
        ok: false,
        error: {
          code: 'UNSUPPORTED_RECORD_TYPE',
          message: `Assignment is not supported for ${params.objectType}`,
        },
      };
    }

    const decision = await this.assignmentCore.assign({
      tenantId: params.tenantId,
      objectType: params.objectType,
      attributes: params.attributes,
      // `targetUserId`, never `manualAssigneeId`: the latter is honoured
      // verbatim by the core, which is exactly the check-skipping being removed.
      targetUserId: assigneeId ?? null,
      targetGroupIds: groupId ? [groupId] : null,
      owningGroupId: groupId ?? null,
      skipRules: true,
      dryRun: true,
      source: 'automation',
      sourceWorkflowId: params.sourceWorkflowId ?? null,
      metadata: { trigger: 'automation_create_record' },
    });

    if (!decision.assigneeId) {
      this.logger.warn(
        `[AssigneeResolver] ${params.objectType} target rejected ` +
          `(user=${assigneeId ?? 'none'} group=${groupId ?? 'none'}): ${decision.reason}`,
      );
      return {
        ok: false,
        error: {
          code:
            decision.outcome === 'skipped'
              ? 'AUTO_ASSIGN_DISABLED'
              : 'NO_ELIGIBLE_AGENT',
          message: decision.reason,
        },
      };
    }

    return {
      ok: true,
      ownerId: decision.assigneeId,
      groupId: decision.groupId ?? groupId ?? null,
    };
  }
}

// Create Task

@Injectable()
export class CreateTaskExecutor implements ActionExecutor {
  readonly actionType = 'create_task';
  private readonly logger = new Logger(CreateTaskExecutor.name);

  constructor(
    private readonly tasksService: TasksService,
    private readonly templateEngine: TemplateInterpolationService,
    private readonly assigneeResolver: AutomationAssigneeResolver,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordType, actionConfig, tenantId, recordData } = job;

    const title = this.templateEngine.interpolate(
      actionConfig.title ?? 'Follow up',
      recordData,
    );

    const dueDate = this.resolveDueDate(actionConfig);

    // Eligibility is decided by the assignment core, not by whatever id the node
    // config names — see AutomationAssigneeResolver.
    const assignment = await this.assigneeResolver.resolve({
      tenantId,
      objectType: 'Task',
      assigneeId: actionConfig.assigneeId,
      groupId: actionConfig.groupId,
      attributes: recordData,
      sourceWorkflowId: job.sourceWorkflowId,
      fallbackOwnerId: recordData.ownerId,
    });
    if (!assignment.ok) {
      return { success: false, retryable: false, error: assignment.error };
    }

    this.logger.log(
      `[CreateTask] tenant=${tenantId} title="${title}" dueDate=${dueDate.toISOString()} ` +
        `owner=${assignment.ownerId ?? 'unassigned'} triggeredBy=${recordType}(${recordId})`,
    );

    const task = await this.tasksService.create({
      title,
      description: actionConfig.description
        ? this.templateEngine.interpolate(actionConfig.description, recordData)
        : undefined,
      dueDate,
      priority: actionConfig.priority ?? 'MEDIUM',
      ownerId: assignment.ownerId ?? undefined,
      categoryId: actionConfig.categoryId,
      relatedTo: {
        type: recordType,
        id: recordId,
        name:
          recordData.name ||
          recordData.title ||
          recordData.subject ||
          recordData.firstName ||
          recordId,
      },
      tags: actionConfig.tags,
    } as any);

    return { success: true, output: { taskId: task.id, title: task.title } };
  }

  private resolveDueDate(actionConfig: Record<string, any>): Date {
    if (actionConfig.dueDateOffsetDays) {
      return new Date(
        Date.now() + Number(actionConfig.dueDateOffsetDays) * 86_400_000,
      );
    }
    if (actionConfig.dueDate) return new Date(actionConfig.dueDate);
    return new Date(Date.now() + 86_400_000); // tomorrow
  }
}

// Create Ticket

@Injectable()
export class CreateTicketExecutor implements ActionExecutor {
  readonly actionType = 'create_ticket';
  private readonly logger = new Logger(CreateTicketExecutor.name);

  constructor(
    private readonly ticketsService: TicketsService,
    private readonly templateEngine: TemplateInterpolationService,
    private readonly assigneeResolver: AutomationAssigneeResolver,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordType, actionConfig, tenantId, recordData } = job;

    const subject = this.templateEngine.interpolate(
      actionConfig.subject ?? 'Support Request',
      recordData,
    );

    const contactId =
      actionConfig.contactId ||
      (recordType === 'Contact' ? recordId : recordData.contactId) ||
      undefined;

    const omniConversationId =
      actionConfig.omniConversationId ||
      (recordType === 'Conversation'
        ? recordId
        : recordData.omniConversationId) ||
      undefined;

    // Same eligibility gate as create_task. A ticket handed to an agent who is
    // not in the channel's support pool (or not even in this tenant) is exactly
    // what route_to_group was fixed to prevent.
    const assignment = await this.assigneeResolver.resolve({
      tenantId,
      objectType: 'Ticket',
      assigneeId: actionConfig.assigneeId,
      groupId: actionConfig.groupId,
      attributes: recordData,
      sourceWorkflowId: job.sourceWorkflowId,
      fallbackOwnerId: recordData.ownerId,
    });
    if (!assignment.ok) {
      return { success: false, retryable: false, error: assignment.error };
    }

    this.logger.log(
      `[CreateTicket] tenant=${tenantId} subject="${subject}" contactId=${contactId} ` +
        `owner=${assignment.ownerId ?? 'unassigned'} triggeredBy=${recordType}(${recordId})`,
    );

    const ticket = await this.ticketsService.create({
      subject,
      description: actionConfig.description
        ? this.templateEngine.interpolate(actionConfig.description, recordData)
        : undefined,
      priority: actionConfig.priority ?? 'MEDIUM',
      statusId: actionConfig.statusId,
      typeId: actionConfig.typeId,
      sourceId: actionConfig.sourceId,
      ownerId: assignment.ownerId ?? undefined,
      groupId: assignment.groupId ?? undefined,
      contactId,
      accountId: recordData.accountId,
      omniConversationId,
      tags: actionConfig.tags,
    } as any);

    return {
      success: true,
      output: {
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        subject: ticket.subject,
      },
    };
  }
}
