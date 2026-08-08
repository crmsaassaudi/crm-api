/**
 * Barrel re-export: Interfaces and types used by all executors.
 *
 * This module is the "contract" between executors and the processor layer.
 * Executors import their dependencies directly; consumers only need
 * ActionExecutor + ActionExecutionResult from here.
 */
import { AutomationActionJobData } from '../../queue/automation-queue.constants';

export interface ActionExecutor {
  readonly actionType: string;
  execute(job: AutomationActionJobData): Promise<ActionExecutionResult>;
}

export interface ActionExecutionResult {
  success: boolean;
  output?: Record<string, any>;
  error?: { code: string; message: string };
  retryable?: boolean;
}
