import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { BaseConsumer } from '../../queue/base.consumer';
import {
  AUTOMATION_ACTION_QUEUE,
  AutomationActionJobData,
} from './automation-queue.constants';
import {
  ActionExecutor,
  ActionExecutionResult,
  SendEmailExecutor,
  SendSmsExecutor,
  UpdateFieldExecutor,
  RouteToTeamExecutor,
} from '../engine/action-executors';
import { AutomationExecutionLogRepository } from '../infrastructure/persistence/document/repositories/automation-execution-log.repository';

/**
 * AutomationActionProcessor — BullMQ consumer for automation action jobs.
 *
 * Receives jobs dispatched by the WorkflowOrchestrator, resolves the
 * correct ActionExecutor by action type, executes it, and logs the result
 * back to the execution log.
 *
 * Follows the BaseConsumer pattern from SlaBreachProcessor.
 */
@Processor(AUTOMATION_ACTION_QUEUE)
export class AutomationActionProcessor extends BaseConsumer {
  protected readonly logger = new Logger(AutomationActionProcessor.name);

  /** Map of action type → executor instance */
  private readonly executors: Map<string, ActionExecutor>;

  constructor(
    private readonly executionLogRepo: AutomationExecutionLogRepository,
    sendEmail: SendEmailExecutor,
    sendSms: SendSmsExecutor,
    updateField: UpdateFieldExecutor,
    routeToTeam: RouteToTeamExecutor,
  ) {
    super();
    this.executors = new Map<string, ActionExecutor>([
      [sendEmail.actionType, sendEmail],
      [sendSms.actionType, sendSms],
      [updateField.actionType, updateField],
      [routeToTeam.actionType, routeToTeam],
    ]);
  }

  async process(job: Job<AutomationActionJobData>): Promise<void> {
    const data = job.data;
    const stepStart = new Date();

    this.logger.log(
      `[Processor] Job ${job.id} | action=${data.actionType} workflow=${data.workflowId} node=${data.nodeId}`,
    );

    const executor = this.executors.get(data.actionType);

    if (!executor) {
      const errorMsg = `Unknown action type: ${data.actionType}`;
      this.logger.error(`[Processor] ${errorMsg}`);

      await this.logActionStep(data, stepStart, {
        success: false,
        error: { code: 'UNKNOWN_ACTION_TYPE', message: errorMsg },
      });

      throw new Error(errorMsg);
    }

    try {
      const result = await executor.execute(data);

      await this.logActionStep(data, stepStart, result);

      if (!result.success) {
        this.logger.warn(
          `[Processor] Action ${data.actionType} failed for node=${data.nodeId}: ${result.error?.message}`,
        );
        throw new Error(result.error?.message || 'Action execution failed');
      }

      this.logger.log(
        `[Processor] ✅ Action ${data.actionType} completed for node=${data.nodeId}`,
      );
    } catch (error: any) {
      // Log if not already logged
      if (!error.message?.startsWith('Action execution failed')) {
        await this.logActionStep(data, stepStart, {
          success: false,
          error: { code: 'EXECUTOR_EXCEPTION', message: error.message },
        });
      }

      throw error; // Re-throw for BullMQ retry
    }
  }

  /**
   * Log the action execution result to the execution log.
   */
  private async logActionStep(
    data: AutomationActionJobData,
    stepStart: Date,
    result: ActionExecutionResult,
  ): Promise<void> {
    try {
      await this.executionLogRepo.logStep(data.executionId, {
        nodeId: data.nodeId,
        nodeName: data.nodeName,
        nodeType: 'action',
        status: result.success ? 'success' : 'failed',
        input: {
          actionType: data.actionType,
          recordId: data.recordId,
          recordType: data.recordType,
        },
        output: result.output,
        error: result.error
          ? { code: result.error.code, message: result.error.message }
          : undefined,
        startedAt: stepStart,
        completedAt: new Date(),
        duration: Date.now() - stepStart.getTime(),
      });
    } catch (logError: any) {
      this.logger.error(
        `[Processor] Failed to log step for execution=${data.executionId}: ${logError.message}`,
      );
    }
  }
}
