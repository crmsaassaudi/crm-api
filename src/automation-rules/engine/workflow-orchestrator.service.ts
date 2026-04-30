import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { AutomationWorkflowRepository } from '../infrastructure/persistence/document/repositories/automation-workflow.repository';
import { AutomationExecutionLogRepository } from '../infrastructure/persistence/document/repositories/automation-execution-log.repository';
import {
  ConditionEvaluatorService,
  ConditionGroup,
} from './condition-evaluator.service';
import { LoopPreventionService } from './loop-prevention.service';
import { AutomationActionProducer } from '../queue/automation-action.producer';
import { AutomationDelayedProducer } from '../queue/automation-delayed.producer';
import { AutomationEventPayload } from '../events/automation-event.payload';
import {
  AutomationActionJobData,
  AutomationDelayedJobData,
} from '../queue/automation-queue.constants';

/**
 * Wait/Delay node configuration schema.
 */
interface WaitNodeConfig {
  name?: string;
  delayType: 'fixed'; // Phase 4.0: fixed delay only
  delayValue: number; // e.g. 30
  delayUnit: 'minutes' | 'hours' | 'days';
}

/**
 * WorkflowOrchestratorService — the brain of the Automation Engine.
 *
 * Coordinates the full execution of a workflow for a given record:
 *   1. Loop prevention checks (all 3 layers)
 *   2. Walk the DAG: Trigger → Condition(s) → Action(s) → Wait(s)
 *   3. For condition nodes: evaluate nested AND/OR groups
 *   4. For action nodes: dispatch to BullMQ typed queues
 *   5. For wait nodes: serialize state → delayed queue → stop traversal
 *   6. Write execution logs at each step
 *
 * Supports True/False Split branching on condition nodes.
 * Supports Delay/Wait nodes (Stateful DAG — hibernate and resume).
 *
 * @see docs/prd-visual-automation-builder.md — Task 1.6
 */
@Injectable()
export class WorkflowOrchestratorService {
  private readonly logger = new Logger(WorkflowOrchestratorService.name);

  constructor(
    private readonly workflowRepo: AutomationWorkflowRepository,
    private readonly executionLogRepo: AutomationExecutionLogRepository,
    private readonly conditionEvaluator: ConditionEvaluatorService,
    private readonly loopPrevention: LoopPreventionService,
    private readonly actionProducer: AutomationActionProducer,
    private readonly delayedProducer: AutomationDelayedProducer,
  ) {}

  /**
   * Execute a workflow for a given record.
   * Called from AutomationEventListenerService for each matched workflow.
   */
  async execute(
    workflow: any, // Lean document from findActiveByTrigger
    payload: AutomationEventPayload,
  ): Promise<void> {
    const tenantId = payload.tenantId;
    const workflowId = workflow._id.toString();
    const recordId = payload.recordId;
    const depth = payload.automationDepth ?? 0;
    const executionSessionId = uuid();

    this.logger.log(
      `[Orchestrator] Starting workflow "${workflow.name}" (${workflowId}) for record=${recordId} depth=${depth}`,
    );

    // ── Layer 2: Depth limit check (synchronous) ──────────────────────────
    const depthCheck = this.loopPrevention.checkDepthLimit(depth);
    if (!depthCheck.allowed) {
      this.logger.warn(`[Orchestrator] DEPTH_EXCEEDED: ${depthCheck.reason}`);
      const execLog = await this.executionLogRepo.startExecution({
        tenantId,
        workflowId,
        workflowName: workflow.name,
        recordId,
        recordType: payload.object,
        automationDepth: depth,
      });
      await this.executionLogRepo.blockExecution(execLog._id.toString(), {
        code: 'LOOP_DEPTH_EXCEEDED',
        message: depthCheck.reason!,
      });
      return;
    }

    // ── Layer 3: Run-once check ───────────────────────────────────────────
    if (workflow.triggerConfig?.runOncePerRecord) {
      const runOnceCheck = await this.loopPrevention.checkRunOnce({
        tenantId,
        workflowId,
        recordId,
      });

      if (!runOnceCheck.allowed) {
        this.logger.debug(
          `[Orchestrator] RUN_ONCE_SKIPPED: ${runOnceCheck.reason}`,
        );
        const execLog = await this.executionLogRepo.startExecution({
          tenantId,
          workflowId,
          workflowName: workflow.name,
          recordId,
          recordType: payload.object,
          automationDepth: depth,
        });
        await this.executionLogRepo.skipExecution(execLog._id.toString());
        return;
      }

      // Mark as executed for future run-once checks
      await this.loopPrevention.markRunOnce({ tenantId, workflowId, recordId });
    }

    // ── Start execution log ───────────────────────────────────────────────
    const execLog = await this.executionLogRepo.startExecution({
      tenantId,
      workflowId,
      workflowName: workflow.name,
      recordId,
      recordType: payload.object,
      automationDepth: depth,
    });
    const executionId = execLog._id.toString();

    try {
      // ── Walk the DAG (using PUBLISHED snapshot — immune to live edits) ──
      const nodes: any[] = workflow.publishedNodes || [];
      const edges: any[] = workflow.publishedEdges || [];

      // Guard: refuse to execute unpublished workflows
      if (nodes.length === 0) {
        throw new Error(
          'UNPUBLISHED_WORKFLOW: No published nodes found. Workflow must be published before execution.',
        );
      }

      // Find the trigger node (entry point)
      const triggerNode = nodes.find((n: any) => n.type === 'trigger');
      if (!triggerNode) {
        throw new Error('No trigger node found in published workflow');
      }

      // BFS traversal from trigger node
      const hibernated = await this.traverseFromNode(
        triggerNode.id,
        nodes,
        edges,
        payload,
        executionId,
        workflowId,
        tenantId,
        executionSessionId,
        depth,
      );

      // ── Mark success (only if no wait node paused the execution) ────────
      if (!hibernated) {
        await this.executionLogRepo.completeExecution(executionId);
        await this.workflowRepo.incrementExecutionCount(tenantId, workflowId);

        this.logger.log(
          `[Orchestrator] ✅ Workflow "${workflow.name}" completed for record=${recordId}`,
        );
      } else {
        this.logger.log(
          `[Orchestrator] ⏸ Workflow "${workflow.name}" hibernated (wait node) — will resume later`,
        );
        // Execution stays in "running" status until delayed processor completes it
      }
    } catch (error: any) {
      this.logger.error(
        `[Orchestrator] ❌ Workflow "${workflow.name}" failed: ${error.message}`,
        error.stack,
      );
      await this.executionLogRepo.failExecution(executionId, {
        code: 'EXECUTION_ERROR',
        message: error.message,
      });
    }
  }

  /**
   * Resume DAG traversal from a specific node.
   * Called by AutomationDelayedProcessor after a wait timer expires.
   *
   * @param nodeId - Node ID to resume from (downstream of the wait node)
   */
  async resumeFromNode(
    nodeId: string,
    nodes: any[],
    edges: any[],
    payload: AutomationEventPayload,
    executionId: string,
    workflowId: string,
    tenantId: string,
    executionSessionId: string,
    depth: number,
  ): Promise<void> {
    try {
      await this.traverseFromNode(
        nodeId,
        nodes,
        edges,
        payload,
        executionId,
        workflowId,
        tenantId,
        executionSessionId,
        depth,
      );

      // Mark execution as completed after delayed resume finishes
      await this.executionLogRepo.completeExecution(executionId);
      await this.workflowRepo.incrementExecutionCount(tenantId, workflowId);

      this.logger.log(
        `[Orchestrator] ✅ Resumed execution ${executionId} completed`,
      );
    } catch (error: any) {
      this.logger.error(
        `[Orchestrator] ❌ Resumed execution ${executionId} failed: ${error.message}`,
        error.stack,
      );
      await this.executionLogRepo.failExecution(executionId, {
        code: 'RESUME_ERROR',
        message: error.message,
      });
    }
  }

  // ── DAG Traversal ────────────────────────────────────────────────────────

  /**
   * Traverse the DAG from a given node.
   * @returns true if a wait/delay node was encountered (execution is hibernated)
   */
  private async traverseFromNode(
    nodeId: string,
    nodes: any[],
    edges: any[],
    payload: AutomationEventPayload,
    executionId: string,
    workflowId: string,
    tenantId: string,
    executionSessionId: string,
    depth: number,
  ): Promise<boolean> {
    const node = nodes.find((n: any) => n.id === nodeId);
    if (!node) return false;

    const stepStart = new Date();

    // ── Layer 1: Strict loop check ──────────────────────────────────────
    const loopCheck = await this.loopPrevention.checkStrictLoop({
      tenantId,
      executionSessionId,
      nodeId,
    });
    if (!loopCheck.allowed) {
      await this.executionLogRepo.logStep(executionId, {
        nodeId,
        nodeName: node.config?.name || node.type,
        nodeType: node.type,
        status: 'failed',
        input: {},
        error: {
          code: 'LOOP_STRICT_DETECTED',
          message: loopCheck.reason!,
        },
        startedAt: stepStart,
        completedAt: new Date(),
        duration: Date.now() - stepStart.getTime(),
      });
      throw new Error(`LOOP_STRICT_DETECTED: ${loopCheck.reason}`);
    }

    // ── Process node by type ────────────────────────────────────────────
    if (node.type === 'trigger') {
      // Trigger node: just log and move to next
      await this.executionLogRepo.logStep(executionId, {
        nodeId,
        nodeName: 'Trigger',
        nodeType: 'trigger',
        status: 'success',
        input: { event: payload.event, object: payload.object },
        startedAt: stepStart,
        completedAt: new Date(),
        duration: Date.now() - stepStart.getTime(),
      });

      // Follow all edges from trigger
      const nextEdges = edges.filter((e: any) => e.source === nodeId);
      for (const edge of nextEdges) {
        const hibernated = await this.traverseFromNode(
          edge.target,
          nodes,
          edges,
          payload,
          executionId,
          workflowId,
          tenantId,
          executionSessionId,
          depth,
        );
        if (hibernated) return true;
      }
    } else if (node.type === 'condition') {
      // Condition node: evaluate and follow True/False branch
      const conditionConfig = node.config as ConditionGroup | undefined;
      let matched = true;

      if (conditionConfig && conditionConfig.rules) {
        matched = this.conditionEvaluator.evaluate(
          conditionConfig,
          payload.data,
        );
      }

      const branch = matched ? 'matched' : 'not_matched';

      await this.executionLogRepo.logStep(executionId, {
        nodeId,
        nodeName: node.config?.name || 'Condition',
        nodeType: 'condition',
        branch,
        status: 'success',
        input: { conditionConfig, recordData: payload.data },
        output: { matched, branch },
        startedAt: stepStart,
        completedAt: new Date(),
        duration: Date.now() - stepStart.getTime(),
      });

      // Follow edges matching the branch (True/False Split)
      const branchEdges = edges.filter((e: any) => {
        if (e.source !== nodeId) return false;
        // If edge has sourceHandle, match it; otherwise follow all
        if (e.sourceHandle) return e.sourceHandle === branch;
        return matched; // Legacy: only follow if matched
      });

      for (const edge of branchEdges) {
        const hibernated = await this.traverseFromNode(
          edge.target,
          nodes,
          edges,
          payload,
          executionId,
          workflowId,
          tenantId,
          executionSessionId,
          depth,
        );
        if (hibernated) return true;
      }
    } else if (node.type === 'action') {
      // Action node: dispatch to typed queue
      const actionData: AutomationActionJobData = {
        executionId,
        workflowId,
        tenantId,
        nodeId,
        nodeName: node.config?.name || node.config?.actionType || 'Action',
        actionType: node.config?.actionType,
        actionConfig: node.config || {},
        recordId: payload.recordId,
        recordType: payload.object,
        recordData: payload.data,
        automationDepth: depth,
        sourceWorkflowId: workflowId,
      };

      try {
        await this.actionProducer.dispatch(actionData);

        await this.executionLogRepo.logStep(executionId, {
          nodeId,
          nodeName: actionData.nodeName,
          nodeType: 'action',
          status: 'success',
          input: { actionType: node.config?.actionType, config: node.config },
          output: { queued: true },
          startedAt: stepStart,
          completedAt: new Date(),
          duration: Date.now() - stepStart.getTime(),
        });
      } catch (error: any) {
        await this.executionLogRepo.logStep(executionId, {
          nodeId,
          nodeName: actionData.nodeName,
          nodeType: 'action',
          status: 'failed',
          input: { actionType: node.config?.actionType },
          error: { code: 'ACTION_DISPATCH_FAILED', message: error.message },
          startedAt: stepStart,
          completedAt: new Date(),
          duration: Date.now() - stepStart.getTime(),
        });
        throw error;
      }

      // Follow edges from action to next nodes (chaining)
      const nextEdges = edges.filter((e: any) => e.source === nodeId);
      for (const edge of nextEdges) {
        const hibernated = await this.traverseFromNode(
          edge.target,
          nodes,
          edges,
          payload,
          executionId,
          workflowId,
          tenantId,
          executionSessionId,
          depth,
        );
        if (hibernated) return true;
      }
    } else if (node.type === 'wait') {
      // ── Wait/Delay node: hibernate execution ──────────────────────────
      const config = node.config as WaitNodeConfig;
      const delayMs = this.computeDelayMs(config);

      this.logger.log(
        `[Orchestrator] ⏸ Wait node "${config.name || 'Wait'}": ` +
          `delay=${config.delayValue} ${config.delayUnit} (${delayMs}ms)`,
      );

      // Log the wait step
      await this.executionLogRepo.logStep(executionId, {
        nodeId,
        nodeName: config.name || 'Wait',
        nodeType: 'wait' as any,
        status: 'waiting' as any,
        input: {
          delayType: config.delayType,
          delayValue: config.delayValue,
          delayUnit: config.delayUnit,
        },
        output: {
          delayMs,
          resumeAt: new Date(Date.now() + delayMs).toISOString(),
        },
        startedAt: stepStart,
        completedAt: new Date(),
        duration: 0,
      });

      // Schedule delayed resume for each downstream edge
      const nextEdges = edges.filter((e: any) => e.source === nodeId);
      for (const edge of nextEdges) {
        const delayedData: AutomationDelayedJobData = {
          executionId,
          workflowId,
          tenantId,
          resumeFromNodeId: edge.target,
          recordId: payload.recordId,
          recordType: payload.object,
          automationDepth: depth,
          sourceWorkflowId: workflowId,
          executionSessionId,
        };

        await this.delayedProducer.scheduleResume(delayedData, delayMs);
      }

      // STOP traversal — delayed queue will resume
      return true;
    }

    return false;
  }

  /**
   * Compute delay in milliseconds from a WaitNodeConfig.
   */
  private computeDelayMs(config: WaitNodeConfig): number {
    const value = Math.max(1, config.delayValue || 1);

    switch (config.delayUnit) {
      case 'minutes':
        return value * 60 * 1000;
      case 'hours':
        return value * 60 * 60 * 1000;
      case 'days':
        return value * 24 * 60 * 60 * 1000;
      default:
        return value * 60 * 1000; // default to minutes
    }
  }
}
