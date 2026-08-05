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
import { slimRecordForLog } from './execution-log-redaction';
import {
  ExecutionPrincipal,
  resolvePrincipal,
} from '../domain/execution-principal';

/** Hard cap on wait-node delays — 90 days in milliseconds. */
export const MAX_WAIT_DELAY_MS = 90 * 24 * 60 * 60 * 1000;

/** Hard timeout for one traversal segment of a workflow execution. */
const MAX_EXECUTION_TIMEOUT_MS = 30_000;

/** Hard ceiling on nodes visited in a single traversal segment. */
const MAX_TRAVERSAL_STEPS = 1000;

/** Which outgoing edges a completed action node continues along. */
export type ActionBranch = 'success' | 'failure';

/**
 * Wait/Delay node configuration schema.
 */
interface WaitNodeConfig {
  name?: string;
  delayType: 'fixed'; // only a fixed delay is supported
  delayValue: number; // e.g. 30
  delayUnit: 'minutes' | 'hours' | 'days';
}

/**
 * WorkflowOrchestratorService — the brain of the Automation Engine.
 *
 * Walks the published DAG for one record: Trigger → Condition → Action → Wait.
 *
 * Traversal is not a single pass. It suspends at every node whose outcome is only
 * known later, and whoever learns that outcome resumes it:
 *
 *   - wait node → `AutomationDelayedProcessor`, when the timer expires.
 *   - action node → the action worker, through {@link continueAfterAction}, along
 *     the `success` or `failure` edges once the action has really run.
 *
 * So an action's branches mean what they say, chained actions run in order, and
 * the execution is marked successful by the segment that ends with nothing left
 * in flight — not at dispatch, which would make "success rate" mean "dispatch
 * rate".
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
   * Called from TriggerEvaluatorService for each matched workflow.
   */
  async execute(
    workflow: any, // Lean document from findActiveByTrigger
    payload: AutomationEventPayload,
  ): Promise<void> {
    // Hard timeout: prevent unbounded worker blocking.
    // The timer MUST be cleared on normal completion to avoid handle leaks.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.executeInternal(workflow, payload),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `EXECUTION_TIMEOUT: Workflow "${workflow.name}" exceeded ${MAX_EXECUTION_TIMEOUT_MS}ms`,
                ),
              ),
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

    // Resolve WHO this execution acts as, once, before anything runs. Every
    // action job carries it so the worker can rebuild the same authorization
    // context an HTTP request would have had.
    const principal = resolvePrincipal({
      runAs: workflow.runAs,
      workflowId,
      workflowCreatedBy: workflow.createdBy,
      triggerUserId: payload.triggerUserId,
      recordOwnerId: payload.data?.ownerId,
    });

    this.logger.log(
      `[Orchestrator] Starting workflow "${workflow.name}" (${workflowId}) for ` +
        `record=${recordId} depth=${depth} runAs=${principal.runAs}` +
        `${principal.kind === 'user' ? ` as user=${principal.userId}` : ' as system'}` +
        `${principal.fallbackReason ? ` (fallback: ${principal.fallbackReason})` : ''}`,
    );

    // Layer 2: Depth limit check (synchronous)
    const depthCheck = this.loopPrevention.checkDepthLimit(depth);
    if (!depthCheck.allowed) {
      this.logger.warn(`[Orchestrator] DEPTH_EXCEEDED: ${depthCheck.reason}`);
      await this.recordBlocked(workflow, payload, {
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
      await this.recordBlocked(workflow, payload, {
        code: 'LOOP_BREADCRUMB_DETECTED',
        message: breadcrumbCheck.reason!,
      });
      return;
    }

    // Layer 3: Run-once check.
    //
    // Read from the PUBLISHED snapshot, like every other execution-time
    // decision. Reading the draft meant toggling this switch took effect on the
    // running workflow without publishing — and, worse, un-toggling it in a
    // draft silently removed run-once protection from the live version. For a
    // flag whose whole job is "do not contact this person twice", that is the
    // expensive direction to get wrong.
    if (workflow.publishedTriggerConfig?.runOncePerRecord) {
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
        const execLog = await this.startExecutionLog(workflow, payload);
        await this.executionLogRepo.skipExecution(execLog._id.toString());
        return;
      }
    }

    const execLog = await this.startExecutionLog(workflow, payload);
    const executionId = execLog._id.toString();
    const stepLogs: ExecutionStep[] = [];

    try {
      // Walk the DAG (using PUBLISHED snapshot — immune to live edits)
      const nodes: any[] = workflow.publishedNodes || [];
      const edges: any[] = workflow.publishedEdges || [];

      // Guard: refuse to execute unpublished workflows
      if (nodes.length === 0) {
        throw new Error(
          'UNPUBLISHED_WORKFLOW: No published nodes found. Workflow must be published before execution.',
        );
      }

      const graph = this.buildGraphIndex(
        nodes,
        edges,
        workflow.version ?? null,
        principal,
      );

      const triggerNode = nodes.find((n: any) => n.type === 'trigger');
      if (!triggerNode) {
        throw new Error('No trigger node found in published workflow');
      }

      const suspended = await this.traverseFromNode(triggerNode.id, {
        graph,
        payload,
        executionId,
        workflowId,
        tenantId,
        executionSessionId,
        depth,
        stepLogs,
      });

      await this.flushStepLogs(executionId, stepLogs);
      await this.settleSegment(executionId, tenantId, workflowId, suspended);
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
   * Resume DAG traversal from a specific node after a wait node's timer expired.
   * Called by AutomationDelayedProcessor.
   */
  async resumeFromNode(nodeId: string, ctx: ResumeContext): Promise<void> {
    const stepLogs: ExecutionStep[] = [];
    const graph = this.buildGraphIndex(
      ctx.publishedNodes,
      ctx.publishedEdges,
      ctx.workflowVersion,
      ctx.principal,
    );
    try {
      const suspended = await this.traverseFromNode(nodeId, {
        graph,
        payload: ctx.payload,
        executionId: ctx.executionId,
        workflowId: ctx.workflowId,
        tenantId: ctx.tenantId,
        executionSessionId: ctx.executionSessionId,
        depth: ctx.depth,
        stepLogs,
      });

      await this.flushStepLogs(ctx.executionId, stepLogs);
      await this.settleSegment(
        ctx.executionId,
        ctx.tenantId,
        ctx.workflowId,
        suspended,
      );
    } catch (error: any) {
      this.logger.error(
        `[Orchestrator] ❌ Resumed execution ${ctx.executionId} failed: ${error.message}`,
        error.stack,
      );
      await this.flushStepLogs(ctx.executionId, stepLogs);
      await this.executionLogRepo.failExecution(ctx.executionId, {
        code: 'RESUME_ERROR',
        message: error.message,
      });
    }
  }

  /**
   * Continue the graph after an action node reached a terminal outcome.
   *
   * Called by the action worker — the only place that knows whether the action
   * happened. A labelled edge is followed on its matching branch; an unlabelled
   * edge is the plain "next step" and is followed only on success, because a
   * chain that continues past a failed step is how an escalation ends up firing
   * on every send.
   *
   * A failed action ends the execution as `failed` even when its failure branch
   * runs: the recovery path executing does not make the action have succeeded.
   */
  async continueAfterAction(
    job: AutomationActionJobData,
    branch: ActionBranch,
    error?: { code: string; message: string },
  ): Promise<void> {
    const graph = this.buildGraphIndex(
      job.publishedNodes,
      job.publishedEdges,
      job.workflowVersion,
      job.principal,
    );

    const edges = (graph.edgeMap.get(job.nodeId) ?? []).filter((e: any) =>
      e.sourceHandle
        ? e.sourceHandle === branch
        : branch === 'success' && !e.sourceHandle,
    );

    const stepLogs: ExecutionStep[] = [];
    let suspended = false;
    try {
      for (const edge of edges) {
        const branchSuspended = await this.traverseFromNode(edge.target, {
          graph,
          payload: {
            tenantId: job.tenantId,
            event: 'record_created',
            object: job.recordType,
            recordId: job.recordId,
            data: job.recordData,
            automationDepth: job.automationDepth,
            automationBreadcrumbs: job.automationBreadcrumbs,
            _automationSourceWorkflowId: job.sourceWorkflowId,
          },
          executionId: job.executionId,
          workflowId: job.workflowId,
          tenantId: job.tenantId,
          executionSessionId: job.executionSessionId,
          depth: job.automationDepth,
          stepLogs,
        });
        suspended = branchSuspended || suspended;
      }
      await this.flushStepLogs(job.executionId, stepLogs);
    } catch (traversalError: any) {
      await this.flushStepLogs(job.executionId, stepLogs);
      await this.executionLogRepo.failExecution(job.executionId, {
        code: 'CONTINUATION_ERROR',
        message: traversalError.message,
        nodeId: job.nodeId,
      });
      return;
    }

    if (branch === 'failure') {
      await this.executionLogRepo.failExecution(job.executionId, {
        code: error?.code ?? 'ACTION_FAILED',
        message: error?.message ?? `Action ${job.actionType} failed`,
        nodeId: job.nodeId,
      });
      return;
    }

    await this.settleSegment(
      job.executionId,
      job.tenantId,
      job.workflowId,
      suspended,
    );
  }

  // DAG Traversal

  /**
   * Traverse the DAG from a given node.
   * @returns true when the execution suspended (wait or action node)
   */
  private async traverseFromNode(
    nodeId: string,
    ctx: TraversalContext,
  ): Promise<boolean> {
    const node = ctx.graph.nodeMap.get(nodeId);
    if (!node) return false;

    // Defence in depth behind the save-time cycle check.
    if (ctx.stepLogs.length > MAX_TRAVERSAL_STEPS) {
      throw new Error(
        `MAX_STEPS_EXCEEDED: traversal processed more than ${MAX_TRAVERSAL_STEPS} steps (possible cycle)`,
      );
    }

    const stepStart = new Date();

    // Layer 1: Strict loop check
    const loopCheck = await this.loopPrevention.checkStrictLoop({
      tenantId: ctx.tenantId,
      executionSessionId: ctx.executionSessionId,
      nodeId,
    });
    if (!loopCheck.allowed) {
      ctx.stepLogs.push({
        nodeId,
        nodeName: node.config?.name || node.type,
        nodeType: node.type,
        status: 'failed',
        input: {},
        error: { code: 'LOOP_STRICT_DETECTED', message: loopCheck.reason! },
        startedAt: stepStart,
        completedAt: new Date(),
        duration: Date.now() - stepStart.getTime(),
      });
      throw new Error(`LOOP_STRICT_DETECTED: ${loopCheck.reason}`);
    }

    switch (node.type) {
      case 'trigger':
        return this.processTriggerNode(node, stepStart, ctx);
      case 'condition':
        return this.processConditionNode(node, stepStart, ctx);
      case 'action':
        return this.processActionNode(node, stepStart, ctx);
      case 'wait':
        return this.processWaitNode(node, stepStart, ctx);
      default:
        // Unreachable: the node type enum is validated at save time.
        throw new Error(
          `UNSUPPORTED_NODE_TYPE: node "${nodeId}" has type "${node.type}"`,
        );
    }
  }

  /**
   * Follow a set of edges, traversing every one of them.
   *
   * Deliberately does NOT stop at the first suspension. Returning early meant a
   * node that fanned out to two actions only ever dispatched the first — the
   * second branch was silently dropped the moment suspension points existed.
   */
  private async traverseEdges(
    edges: any[],
    ctx: TraversalContext,
  ): Promise<boolean> {
    let suspended = false;
    for (const edge of edges) {
      const edgeSuspended = await this.traverseFromNode(edge.target, ctx);
      suspended = edgeSuspended || suspended;
    }
    return suspended;
  }

  // Node-type handlers

  private async processTriggerNode(
    node: any,
    stepStart: Date,
    ctx: TraversalContext,
  ): Promise<boolean> {
    ctx.stepLogs.push({
      nodeId: node.id,
      nodeName: 'Trigger',
      nodeType: 'trigger',
      status: 'success',
      input: { event: ctx.payload.event, object: ctx.payload.object },
      startedAt: stepStart,
      completedAt: new Date(),
      duration: Date.now() - stepStart.getTime(),
    });

    return this.traverseEdges(ctx.graph.edgeMap.get(node.id) ?? [], ctx);
  }

  private async processConditionNode(
    node: any,
    stepStart: Date,
    ctx: TraversalContext,
  ): Promise<boolean> {
    const conditionConfig = node.config as ConditionGroup;
    const matched = this.conditionEvaluator.evaluate(
      conditionConfig,
      ctx.payload.data,
    );
    const branch = matched ? 'matched' : 'not_matched';

    ctx.stepLogs.push({
      nodeId: node.id,
      nodeName: node.config?.name ?? 'Condition',
      nodeType: 'condition',
      branch,
      status: 'success',
      input: {
        conditionConfig,
        recordData: slimRecordForLog(ctx.payload.data),
      },
      output: { matched, branch },
      startedAt: stepStart,
      completedAt: new Date(),
      duration: Date.now() - stepStart.getTime(),
    });

    const branchEdges = (ctx.graph.edgeMap.get(node.id) ?? []).filter(
      (e: any) => (e.sourceHandle ? e.sourceHandle === branch : matched),
    );
    return this.traverseEdges(branchEdges, ctx);
  }

  /**
   * Dispatch the action and suspend.
   *
   * No step is logged here. The worker logs the one step this node gets, with
   * its real outcome — the previous "queued" placeholder wrote a status that is
   * not in the step-status enum and produced two log entries per action, the
   * first of which claimed nothing and the second of which overwrote it in
   * every reader.
   */
  private async processActionNode(
    node: any,
    stepStart: Date,
    ctx: TraversalContext,
  ): Promise<boolean> {
    const actionConfig = await this.encryptActionConfigForQueue(
      node.config || {},
    );
    const nodeName = actionConfig?.name ?? actionConfig?.actionType ?? 'Action';
    const actionData: AutomationActionJobData = {
      executionId: ctx.executionId,
      workflowId: ctx.workflowId,
      tenantId: ctx.tenantId,
      nodeId: node.id,
      nodeName,
      actionType: actionConfig.actionType,
      actionConfig,
      recordId: ctx.payload.recordId,
      recordType: ctx.payload.object,
      recordData: ctx.payload.data,
      automationDepth: ctx.depth,
      automationBreadcrumbs: this.appendBreadcrumb(
        ctx.payload.automationBreadcrumbs,
        ctx.workflowId,
      ),
      sourceWorkflowId: ctx.workflowId,
      principal: ctx.graph.principal,
      executionSessionId: ctx.executionSessionId,
      workflowVersion: ctx.graph.version,
      publishedNodes: ctx.graph.nodes,
      publishedEdges: ctx.graph.edges,
    };

    try {
      // Persist the steps taken to get here BEFORE the side effect is queued.
      // The worker can complete or fail this execution as soon as the job lands,
      // and a trace that starts at the action tells nobody which condition let it
      // through.
      await this.flushStepLogs(ctx.executionId, ctx.stepLogs);
      await this.actionProducer.dispatch(actionData);
    } catch (error: any) {
      ctx.stepLogs.push({
        nodeId: node.id,
        nodeName,
        nodeType: 'action',
        status: 'failed',
        input: { actionType: actionConfig.actionType },
        error: { code: 'ACTION_DISPATCH_FAILED', message: error.message },
        startedAt: stepStart,
        completedAt: new Date(),
        duration: Date.now() - stepStart.getTime(),
      });
      throw error;
    }

    // Suspend: the worker continues from here once the action has really run.
    return true;
  }

  private async processWaitNode(
    node: any,
    stepStart: Date,
    ctx: TraversalContext,
  ): Promise<boolean> {
    const config = node.config as WaitNodeConfig;
    const delayMs = this.computeDelayMs(config);

    this.logger.log(
      `[Orchestrator] ⏸ Wait node "${config.name ?? 'Wait'}": ` +
        `delay=${config.delayValue} ${config.delayUnit} (${delayMs}ms)`,
    );

    ctx.stepLogs.push({
      nodeId: node.id,
      nodeName: config.name ?? 'Wait',
      nodeType: 'wait',
      status: 'waiting',
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
    // Same reason as the action node: the resume must not be schedulable before
    // the log says the execution is waiting.
    await this.flushStepLogs(ctx.executionId, ctx.stepLogs);

    for (const edge of ctx.graph.edgeMap.get(node.id) ?? []) {
      const delayedData: AutomationDelayedJobData = {
        executionId: ctx.executionId,
        workflowId: ctx.workflowId,
        tenantId: ctx.tenantId,
        resumeFromNodeId: edge.target,
        recordId: ctx.payload.recordId,
        recordType: ctx.payload.object,
        automationDepth: ctx.depth,
        automationBreadcrumbs: this.appendBreadcrumb(
          ctx.payload.automationBreadcrumbs,
          ctx.workflowId,
        ),
        sourceWorkflowId: ctx.workflowId,
        executionSessionId: ctx.executionSessionId,
        principal: ctx.graph.principal,
        workflowVersion: ctx.graph.version,
        publishedNodes: ctx.graph.nodes,
        publishedEdges: ctx.graph.edges,
      };
      await this.delayedProducer.scheduleResume(delayedData, delayMs);
    }

    return true;
  }

  // Execution-log lifecycle

  private startExecutionLog(workflow: any, payload: AutomationEventPayload) {
    return this.executionLogRepo.startExecution({
      tenantId: payload.tenantId,
      workflowId: workflow._id.toString(),
      workflowName: workflow.name,
      recordId: payload.recordId,
      recordType: payload.object,
      automationDepth: payload.automationDepth ?? 0,
      workflowVersion: workflow.version ?? null,
    });
  }

  private async recordBlocked(
    workflow: any,
    payload: AutomationEventPayload,
    error: { code: string; message: string },
  ): Promise<void> {
    const execLog = await this.startExecutionLog(workflow, payload);
    await this.executionLogRepo.blockExecution(execLog._id.toString(), error);
  }

  /**
   * Close out a traversal segment.
   *
   * An execution finishes when a segment ends with nothing left in flight. With
   * parallel branches several segments can reach this point; `completeExecution`
   * refuses to overwrite a terminal status, so one failed branch is not erased
   * by a sibling that succeeded.
   */
  private async settleSegment(
    executionId: string,
    tenantId: string,
    workflowId: string,
    suspended: boolean,
  ): Promise<void> {
    if (suspended) {
      this.logger.debug(
        `[Orchestrator] ⏸ Execution ${executionId} suspended — work in flight`,
      );
      return;
    }

    await this.executionLogRepo.completeExecution(executionId);
    await this.workflowRepo.incrementExecutionCount(tenantId, workflowId);
    this.logger.log(`[Orchestrator] ✅ Execution ${executionId} completed`);
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
   * Compute delay in milliseconds from a WaitNodeConfig, capped at
   * {@link MAX_WAIT_DELAY_MS}.
   */
  private computeDelayMs(config: WaitNodeConfig): number {
    const value = Math.max(1, config.delayValue || 1);

    const unitMs: Record<string, number> = {
      minutes: 60_000,
      hours: 3_600_000,
      days: 86_400_000,
    };
    const ms = value * (unitMs[config.delayUnit] ?? unitMs.minutes);

    if (ms > MAX_WAIT_DELAY_MS) {
      this.logger.warn(
        `[Orchestrator] Wait delay ${config.delayValue} ${config.delayUnit} ` +
          `exceeds the ${MAX_WAIT_DELAY_MS}ms cap — clamping`,
      );
      return MAX_WAIT_DELAY_MS;
    }
    return ms;
  }

  private async encryptActionConfigForQueue(
    config: Record<string, any>,
  ): Promise<Record<string, any>> {
    if (config.actionType !== 'webhook') return config;
    return (await this.webhookHeaderCrypto.encryptWebhookConfig(config)).config;
  }

  /** Pre-build O(1) lookup structures for nodes and edges. */
  private buildGraphIndex(
    nodes: any[],
    edges: any[],
    version: number | null,
    principal: ExecutionPrincipal,
  ): GraphIndex {
    const nodeMap = new Map<string, any>();
    for (const n of nodes) nodeMap.set(n.id, n);

    const edgeMap = new Map<string, any[]>();
    for (const e of edges) {
      const list = edgeMap.get(e.source) ?? [];
      list.push(e);
      edgeMap.set(e.source, list);
    }

    return { nodeMap, edgeMap, nodes, edges, version, principal };
  }
}

/**
 * Pre-computed graph index for O(1) lookups during DAG traversal.
 *
 * Also carries the snapshot it was built from, so a suspension point can pin the
 * exact graph and version into the job that will resume it.
 */
interface GraphIndex {
  nodeMap: Map<string, any>;
  edgeMap: Map<string, any[]>;
  /** The published snapshot this index was built from. */
  nodes: any[];
  edges: any[];
  /** Published version of that snapshot. */
  version: number | null;
  /** Principal every action dispatched from this graph executes as. */
  principal: ExecutionPrincipal;
}

/** Shared traversal state passed to each node-type handler. */
interface TraversalContext {
  graph: GraphIndex;
  payload: AutomationEventPayload;
  executionId: string;
  workflowId: string;
  tenantId: string;
  executionSessionId: string;
  depth: number;
  stepLogs: ExecutionStep[];
}

/** Context for resuming a hibernated workflow execution after a wait node. */
export interface ResumeContext {
  publishedNodes: any[];
  publishedEdges: any[];
  workflowVersion: number | null;
  principal: ExecutionPrincipal;
  payload: AutomationEventPayload;
  executionId: string;
  workflowId: string;
  tenantId: string;
  executionSessionId: string;
  depth: number;
}
