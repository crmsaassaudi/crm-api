/**
 * Barrel re-export: Interfaces and types used by all executors.
 *
 * This module is the "contract" between executors and the processor layer.
 * Executors import their dependencies directly; consumers only need
 * ActionExecutor + ActionExecutionResult from here.
 */
import { AutomationActionJobData } from '../../queue/automation-queue.constants';

/**
 * Base interface for all action executors.
 * Each executor handles one action type (email, sms, update_field, etc.).
 */
export interface ActionExecutor {
  readonly actionType: string;
  execute(job: AutomationActionJobData): Promise<ActionExecutionResult>;
}

export interface ActionExecutionResult {
  success: boolean;
  output?: Record<string, any>;
  error?: { code: string; message: string };
  /**
   * Phase 2 Smart Retry: If explicitly false, BullMQ should NOT retry this job.
   * It will be sent directly to the DLQ.
   * Undefined/true = normal BullMQ retry behavior.
   */
  retryable?: boolean;
}
