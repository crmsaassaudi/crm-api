import { Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { AutomationWorkflowRepository } from '../infrastructure/persistence/document/repositories/automation-workflow.repository';
import { AutomationExecutionLogRepository } from '../infrastructure/persistence/document/repositories/automation-execution-log.repository';
import { ExecutionStep } from '../infrastructure/persistence/document/entities/automation-execution-log.schema';
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
import { WebhookHeaderCryptoService } from './webhook-header-crypto.service';

/** Hard cap on wait-node delays — 90 days in milliseconds (MED-04). */
export const MAX_WAIT_DELAY_MS = 90 * 24 * 60 * 60 * 1000;

/** Hard timeout for a single workflow execution (PERF-03). */
const MAX_EXECUTION_TIMEOUT_MS = 30_000;

/**
 * Fields preserved when slimming a record before it is queued / logged.
 * Keeps just what templates and recipient-resolution need, dropping the
 * rest of the record to avoid persisting unnecessary PII (HIGH-07).
 */
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
    private readonly webhookHeaderCrypto: WebhookHeaderCryptoService,
  ) {}

  /**
   * Execute a workflow for a given record.
   * Called from AutomationEventListenerService for each matched workflow.
   */
  async execute(
    workflow: any, // Lean document from findActiveByTrigger
    payload: AutomationEventPayload,
  ): Promise<void> {
    // Hard timeout: prevent unbounded event-listener thread blocking.
    // The timer MUST be cleared on normal completion to avoid handle leaks.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.executeInternal(workflow, payload),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`EXECUTION_TIMEOUT: Workflow "${workflow.name}" exceeded ${MAX_EXECUTION_TIMEOUT_MS}ms`)),
            MAX_EXECUTION_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async executeInternal(
    workflow: any,
    payload: AutomationEventPayload,
  ): Promise<void> {
    const tenantId = payload.tenantId;
    const workflowId = workflow._id.toString();
    const recordId = payload.recordId;
    const depth = payload.automationDepth ?? 0;
    const breadcrumbs = payload.automationBreadcrumbs ?? [];
    const executionSessionId = ulid();

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

    const breadcrumbCheck = this.loopPrevention.checkBreadcrumbs({
      workflowId,
      breadcrumbs,
    });
    if (!breadcrumbCheck.allowed) {
      this.logger.warn(
        `[Orchestrator] BREADCRUMB_LOOP: ${breadcrumbCheck.reason}`,
      );
      const execLog = await this.executionLogRepo.startExecution({
        tenantId,
        workflowId,
        workflowName: workflow.name,
        recordId,
        recordType: payload.object,
        automationDepth: depth,
      });
      await this.executionLogRepo.blockExecution(execLog._id.toString(), {
        code: 'LOOP_BREADCRUMB_DETECTED',
        message: breadcrumbCheck.reason!,
      });
      return;
    }

    // ── Layer 3: Run-once check ───────────────────────────────────────────
    if (workflow.triggerConfig?.runOncePerRecord) {
      // Atomic check-and-mark: eliminates TOCTOU race where two workers
      // both pass a separate check() before either calls mark().
      const runOnceCheck = await this.loopPrevention.checkAndMarkRunOnce({
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
    const stepLogs: ExecutionStep[] = [];

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

      // Pre-build O(1) lookup maps (SCALE-02)
      const graph = this.buildGraphIndex(nodes, edges);

      // Find the trigger node (entry point)
      const triggerNode = graph.nodeMap.get(
        nodes.find((n: any) => n.type === 'trigger')?.id ?? '',
      );
      if (!triggerNode) {
        throw new Error('No trigger node found in published workflow');
      }

      // BFS traversal from trigger node
      const hibernated = await this.traverseFromNode(
        triggerNode.id,
        graph,
        payload,
        executionId,
        workflowId,
        tenantId,
        executionSessionId,
        depth,
        stepLogs,
      );

      // ── Mark success (only if no wait node paused the execution) ────────

      if (!hibernated) {
        await this.flushStepLogs(executionId, stepLogs);
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
      await this.flushStepLogs(executionId, stepLogs);
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
    const stepLogs: ExecutionStep[] = [];
    // Pre-build O(1) lookup maps (SCALE-02)
    const graph = this.buildGraphIndex(nodes, edges);
    try {
      const hibernated = await this.traverseFromNode(
        nodeId,
        graph,
        payload,
        executionId,
        workflowId,
        tenantId,
        executionSessionId,
        depth,
        stepLogs,
      );

      if (!hibernated) {
        // Mark execution as completed after delayed resume finishes
        await this.flushStepLogs(executionId, stepLogs);
        await this.executionLogRepo.completeExecution(executionId);
        await this.workflowRepo.incrementExecutionCount(tenantId, workflowId);

        this.logger.log(
          `[Orchestrator] ✅ Resumed execution ${executionId} completed`,
        );
      } else {
        this.logger.log(
          `[Orchestrator] Resumed execution ${executionId} hibernated again`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `[Orchestrator] ❌ Resumed execution ${executionId} failed: ${error.message}`,
        error.stack,
      );
      await this.flushStepLogs(executionId, stepLogs);
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
    graph: GraphIndex,
    payload: AutomationEventPayload,
    executionId: string,
    workflowId: string,
    tenantId: string,
    executionSessionId: string,
    depth: number,
    stepLogs: ExecutionStep[],
  ): Promise<boolean> {
    const node = graph.nodeMap.get(nodeId);
    if (!node) return false;

    // ── Layer 0: hard step ceiling (CRIT-04 defense-in-depth) ────────────
    // Independent of Redis: bounds total work in a single execution so a cyclic
    // graph that slipped past validation (or a Redis outage disabling the
    // strict-loop guard) can never recurse into a stack overflow.
    const MAX_TOTAL_STEPS = 1000;
    if (stepLogs.length > MAX_TOTAL_STEPS) {
      throw new Error(
        `MAX_STEPS_EXCEEDED: execution processed more than ${MAX_TOTAL_STEPS} steps (possible cycle)`,
      );
    }

    const stepStart = new Date();

    // ── Layer 1: Strict loop check ──────────────────────────────────────
    const loopCheck = await this.loopPrevention.checkStrictLoop({
      tenantId,
      executionSessionId,
      nodeId,
    });
    if (!loopCheck.allowed) {
      this.bufferStep(stepLogs, {
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
      this.bufferStep(stepLogs, {
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
      const nextEdges = graph.edgeMap.get(nodeId) ?? [];
      for (const edge of nextEdges) {
        const hibernated = await this.traverseFromNode(
          edge.target,
          graph,
          payload,
          executionId,
          workflowId,
          tenantId,
          executionSessionId,
          depth,
          stepLogs,
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

      this.bufferStep(stepLogs, {
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
      const allEdgesFromNode = graph.edgeMap.get(nodeId) ?? [];
      const branchEdges = allEdgesFromNode.filter((e: any) => {
        // If edge has sourceHandle, match it; otherwise follow all
        if (e.sourceHandle) return e.sourceHandle === branch;
        return matched; // Legacy: only follow if matched
      });

      for (const edge of branchEdges) {
        const hibernated = await this.traverseFromNode(
          edge.target,
          graph,
          payload,
          executionId,
          workflowId,
          tenantId,
          executionSessionId,
          depth,
          stepLogs,
        );
        if (hibernated) return true;
      }
    } else if (node.type === 'action') {
      const actionConfig = await this.encryptActionConfigForQueue(
        node.config || {},
      );
      // Action node: dispatch to typed queue
      const actionData: AutomationActionJobData = {
        executionId,
        workflowId,
        tenantId,
        nodeId,
        nodeName: actionConfig?.name || actionConfig?.actionType || 'Action',
        actionType: actionConfig?.actionType,
        actionConfig,
        recordId: payload.recordId,
        recordType: payload.object,
        recordData: payload.data,
        automationDepth: depth,
        automationBreadcrumbs: this.appendBreadcrumb(
          payload.automationBreadcrumbs,
          workflowId,
        ),
        sourceWorkflowId: workflowId,
      };

      try {
        await this.actionProducer.dispatch(actionData);

        this.bufferStep(stepLogs, {
          nodeId,
          nodeName: actionData.nodeName,
          nodeType: 'action',
          status: 'queued' as any, // Not 'success' — action is enqueued, not yet executed
          input: { actionType: actionConfig?.actionType, config: actionConfig },
          output: { queued: true },
          startedAt: stepStart,
          completedAt: new Date(),
          duration: Date.now() - stepStart.getTime(),
        });
      } catch (error: any) {
        this.bufferStep(stepLogs, {
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
      const nextEdges = graph.edgeMap.get(nodeId) ?? [];
      for (const edge of nextEdges) {
        const hibernated = await this.traverseFromNode(
          edge.target,
          graph,
          payload,
          executionId,
          workflowId,
          tenantId,
          executionSessionId,
          depth,
          stepLogs,
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
      this.bufferStep(stepLogs, {
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
      await this.flushStepLogs(executionId, stepLogs);

      // Schedule delayed resume for each downstream edge
      const nextEdges = graph.edgeMap.get(nodeId) ?? [];
      for (const edge of nextEdges) {
        const delayedData: AutomationDelayedJobData = {
          executionId,
          workflowId,
          tenantId,
          resumeFromNodeId: edge.target,
          recordId: payload.recordId,
          recordType: payload.object,
          automationDepth: depth,
          automationBreadcrumbs: this.appendBreadcrumb(
            payload.automationBreadcrumbs,
            workflowId,
          ),
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

  private bufferStep(stepLogs: ExecutionStep[], step: ExecutionStep): void {
    stepLogs.push(step);
  }

  private async flushStepLogs(
    executionId: string,
    stepLogs: ExecutionStep[],
  ): Promise<void> {
    if (stepLogs.length === 0) return;
    const batch = stepLogs.splice(0, stepLogs.length);
    await this.executionLogRepo.logSteps(executionId, batch);
  }

  private appendBreadcrumb(
    breadcrumbs: string[] | undefined,
    workflowId: string,
  ): string[] {
    return [...new Set([...(breadcrumbs ?? []), workflowId])];
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

  private async encryptActionConfigForQueue(
    config: Record<string, any>,
  ): Promise<Record<string, any>> {
    if (config.actionType !== 'webhook') return config;
    return (await this.webhookHeaderCrypto.encryptWebhookConfig(config)).config;
  }

  /**
   * Pre-build O(1) lookup structures for nodes and edges.
   * Replaces O(n) find/filter on every traversal step (SCALE-02).
   */
  private buildGraphIndex(nodes: any[], edges: any[]): GraphIndex {
    const nodeMap = new Map<string, any>();
    for (const n of nodes) nodeMap.set(n.id, n);

    const edgeMap = new Map<string, any[]>();
    for (const e of edges) {
      const list = edgeMap.get(e.source) ?? [];
      list.push(e);
      edgeMap.set(e.source, list);
    }

    return { nodeMap, edgeMap };
  }
}

/** Pre-computed graph index for O(1) lookups during DAG traversal. */
interface GraphIndex {
  nodeMap: Map<string, any>;
  edgeMap: Map<string, any[]>;
}
