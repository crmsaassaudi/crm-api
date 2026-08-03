import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AutomationWorkflowRepository } from './infrastructure/persistence/document/repositories/automation-workflow.repository';
import {
  CreateWorkflowDto,
  UpdateWorkflowDto,
  UpdateWorkflowStatusDto,
} from './dto/workflow.dto';
import { ConditionEvaluatorService } from './engine/condition-evaluator.service';
import { AutomationAuditService } from './automation-audit.service';
import { WebhookHeaderCryptoService } from './engine/webhook-header-crypto.service';
import { ChannelConfigRepository } from '../channels/infrastructure/persistence/document/repositories/channel-config.repository';
import { AuthorizationService } from '../common/permissions/authorization.service';
import { DEFAULT_RUN_AS, WorkflowRunAs } from './domain/execution-principal';

/** Node types the orchestrator's traversal actually handles. */
const SUPPORTED_NODE_TYPES = new Set([
  'trigger',
  'condition',
  'action',
  'wait',
] as const);
type SupportedNodeType = 'trigger' | 'condition' | 'action' | 'wait';

/**
 * Action types with a registered executor. Mirrors
 * ActionProcessorMixin.VALID_ACTIONS — that check dead-letters the job at
 * runtime; this one rejects the save.
 */
const SUPPORTED_ACTION_TYPES = new Set([
  'send_email',
  'send_sms',
  'update_field',
  'route_to_group',
  'webhook',
  'create_task',
  'create_ticket',
  'add_tag',
  'remove_tag',
  'add_note',
  'create_record',
  'http_request',
  'send_whatsapp',
  'send_zns',
  'send_livechat',
  'internal_notification',
]);

const WAIT_UNITS = new Set(['minutes', 'hours', 'days']);

/**
 * Action types that have an executor registered but no provider behind it. They
 * stay in SUPPORTED_ACTION_TYPES so an existing workflow still loads and reports
 * a clear runtime error, but no new node may use them.
 */
const NOT_IMPLEMENTED_ACTION_TYPES = new Set(['send_whatsapp', 'send_zns']);

/** Trigger objects that live in omni-inbound, not in the CRM record services. */
const OMNI_TRIGGER_OBJECTS = new Set(['Conversation', 'Message']);

/** Actions that write through CrmRecordUpdateService / a CRM record service. */
const CRM_RECORD_ACTIONS = new Set([
  'update_field',
  'add_tag',
  'remove_tag',
  'add_note',
]);

/**
 * AutomationWorkflowService — business logic for workflow CRUD.
 *
 * Validates workflow structure before saving, ensures tenant isolation
 * via CLS context, provides duplicate/publish functionality, and logs
 * every lifecycle action to the audit trail.
 *
 * Phase 3 additions:
 * - publish(): Snapshots draft → published for immutable execution
 * - Audit logging on every mutation
 * - Activation requires publishedNodes (can't activate unpublished workflows)
 */
@Injectable()
export class AutomationWorkflowService {
  private readonly logger = new Logger(AutomationWorkflowService.name);

  constructor(
    private readonly repo: AutomationWorkflowRepository,
    private readonly cls: ClsService,
    private readonly conditionEvaluator: ConditionEvaluatorService,
    private readonly auditService: AutomationAuditService,
    private readonly webhookHeaderCrypto: WebhookHeaderCryptoService,
    private readonly channelConfigRepo: ChannelConfigRepository,
    private readonly authz: AuthorizationService,
  ) {}

  private get tenantId(): string {
    return this.cls.get('tenantId');
  }

  /**
   * The acting user's Mongo id.
   *
   * `userId` first: CLS stores the resolved Mongo id under that key
   * (TenantInterceptor / PermissionGuard), while `user` holds the raw JWT
   * payload, which has `sub` and no `id`. Reading only `user.id` meant this
   * always fell through to `'system'` — every workflow's `createdBy` and every
   * audit row was attributed to nobody. Same precedence as ContactsService,
   * DealsService and TicketsService use.
   */
  private get userId(): string {
    return this.cls.get('userId') ?? this.cls.get('user.id') ?? 'system';
  }

  /**
   * `runAs: 'system'` is the escalation, so it needs its own grant.
   *
   * A workflow running as `system` acts with full tenant scope: none of the
   * owner, org-unit, sharing-rule or ABAC axes that constrain the author's own
   * requests apply to it. Anyone who can build workflows could therefore read and
   * rewrite every record in the tenant — the finding this gate closes. The other
   * three modes bind the execution to a real user, so `edit`/`create` is enough
   * for them.
   *
   * Omitting `runAs` is treated as choosing `system` (that is the default), so it
   * is gated too — otherwise the check would be trivially bypassed by leaving the
   * field out.
   */
  private async assertMayUseRunAs(runAs?: WorkflowRunAs): Promise<void> {
    const effective = runAs ?? DEFAULT_RUN_AS;
    if (effective !== 'system') return;

    const decision = await this.authz.canPerformAction({
      rule: { action: 'run_as_system', resource: 'automation_workflows' },
      rawUserId: this.userId,
      tenantHint: this.tenantId,
      claims: this.cls.get('user'),
    });

    if (!decision.allowed) {
      throw new BadRequestException(
        'This workflow would run with full tenant scope, which requires ' +
          'automation_workflows:run_as_system. Set runAs to "creator", ' +
          '"trigger_user" or "record_owner" to run it as a real user instead.',
      );
    }
  }

  // Queries

  async findAll() {
    const workflows = await this.repo.findAll(this.tenantId);
    return workflows.map((workflow) => this.redactWorkflowHeaders(workflow));
  }

  async findById(id: string) {
    const workflow = await this.repo.findById(this.tenantId, id);
    if (!workflow) throw new NotFoundException('Workflow not found');
    const migratedWorkflow = await this.migrateWebhookHeadersAtRest(workflow);
    return this.decryptWorkflowHeadersForResponse(migratedWorkflow);
  }

  async findByStatus(status: 'draft' | 'active' | 'paused') {
    const workflows = await this.repo.findByStatus(this.tenantId, status);
    return workflows.map((workflow) => this.redactWorkflowHeaders(workflow));
  }

  // Mutations

  async create(dto: CreateWorkflowDto) {
    this.validateWorkflow(dto);
    const runAs = dto.runAs ?? 'creator';
    await this.assertMayUseRunAs(runAs);
    await this.validateNodeConfigs(
      dto.nodes as any[],
      dto.triggerConfig?.object,
    );
    const encryptedDraftNodes = await this.webhookHeaderCrypto.encryptNodes(
      dto.nodes as any,
    );

    const result = await this.repo.create({
      tenantId: this.tenantId,
      name: dto.name,
      description: dto.description ?? '',
      status: 'draft',
      runAs,
      triggerConfig: dto.triggerConfig as any,
      nodes: encryptedDraftNodes.nodes as any,
      edges: dto.edges as any,
      viewport: dto.viewport ?? { x: 0, y: 0, zoom: 1 },
      executionCount: 0,
      lastExecutedAt: null,
      // Published state starts empty — must Publish before Activating
      publishedNodes: [],
      publishedEdges: [],
      publishedTriggerConfig: null,
      publishedAt: null,
      version: 0,
      createdBy: this.userId,
      updatedBy: this.userId,
    });

    // Audit: workflow created
    await this.auditService.logAction({
      tenantId: this.tenantId,
      userId: this.userId,
      workflowId: result._id.toString(),
      workflowName: result.name,
      action: 'created',
      metadata: {
        triggerEvent: dto.triggerConfig.event,
        triggerObject: dto.triggerConfig.object,
      },
    });

    return this.decryptWorkflowHeadersForResponse(result);
  }

  async update(id: string, dto: UpdateWorkflowDto) {
    const existing = await this.repo.findById(this.tenantId, id);
    if (!existing) throw new NotFoundException('Workflow not found');

    // Optimistic Concurrency Control
    // If the client sends updatedAt, verify it matches the DB timestamp.
    // This prevents 'Last Write Wins' when multiple admins edit simultaneously.
    if (dto.updatedAt) {
      const clientTimestamp = new Date(dto.updatedAt).getTime();
      const dbTimestamp = new Date((existing as any).updatedAt).getTime();

      if (clientTimestamp !== dbTimestamp) {
        throw new ConflictException(
          'This workflow has been modified by another user. Please reload and try again.',
        );
      }
    }

    if (dto.nodes || dto.edges) {
      this.validateWorkflow(dto as any);
    }
    if (dto.runAs && dto.runAs !== (existing as any).runAs) {
      await this.assertMayUseRunAs(dto.runAs);
    }

    if (dto.nodes) {
      // Fall back to the stored trigger when the patch does not carry one, so
      // the object-specific action checks still apply to a nodes-only update.
      await this.validateNodeConfigs(
        dto.nodes as any[],
        dto.triggerConfig?.object ?? (existing as any).triggerConfig?.object,
      );
    }

    // Strip updatedAt from the payload — Mongoose timestamps: true handles it

    const { updatedAt: _clientTs, ...updateData } = dto;
    const [existingDraftNodes, existingPublishedNodes] = await Promise.all([
      this.webhookHeaderCrypto.encryptNodes((existing as any).nodes || []),
      this.webhookHeaderCrypto.encryptNodes(
        (existing as any).publishedNodes || [],
      ),
    ]);
    const existingForDiff = {
      ...(existing as any),
      nodes: existingDraftNodes.nodes,
      publishedNodes: existingPublishedNodes.nodes,
    };
    const encryptedUpdateData: Record<string, any> = { ...updateData };
    const persistData: Record<string, any> = { ...updateData };

    if (updateData.nodes) {
      const encryptedDraftNodes = await this.webhookHeaderCrypto.encryptNodes(
        updateData.nodes as any,
      );
      encryptedUpdateData.nodes = encryptedDraftNodes.nodes;
      persistData.nodes = encryptedDraftNodes.nodes;
    } else if (existingDraftNodes.changed) {
      persistData.nodes = existingDraftNodes.nodes;
    }

    if (existingPublishedNodes.changed) {
      persistData.publishedNodes = existingPublishedNodes.nodes;
    }

    const diff = this.auditService.computeDiff(
      existingForDiff,
      encryptedUpdateData,
    );

    const result = await this.repo.update(this.tenantId, id, {
      ...persistData,
      updatedBy: this.userId,
    } as any);

    // Audit: workflow updated
    if (diff.length > 0) {
      await this.auditService.logAction({
        tenantId: this.tenantId,
        userId: this.userId,
        workflowId: id,
        workflowName: result?.name || existing.name,
        action: 'updated',
        diff,
      });
    }

    return result ? this.decryptWorkflowHeadersForResponse(result) : result;
  }

  /**
   * Publish a workflow: snapshot draft → published for immutable execution.
   * Does NOT change status (Publish is decoupled from Activate).
   */
  async publish(id: string) {
    const existing = await this.repo.findById(this.tenantId, id);
    if (!existing) throw new NotFoundException('Workflow not found');

    // Validate the draft has at least a trigger + 1 action before publishing
    const nodes = existing.nodes || [];
    const hasTrigger = nodes.some(
      (n: any) => n.type === 'trigger' || n.type === 'triggerNode',
    );
    const hasAction = nodes.some(
      (n: any) => n.type === 'action' || n.type === 'actionNode',
    );

    if (!hasTrigger || !hasAction) {
      throw new BadRequestException(
        'Workflow must have at least a Trigger node and one Action node to be published',
      );
    }

    await this.migrateWebhookHeadersAtRest(existing);

    const result = await this.repo.publish(this.tenantId, id);
    if (!result) throw new NotFoundException('Workflow not found');

    // Audit: workflow published
    await this.auditService.logAction({
      tenantId: this.tenantId,
      userId: this.userId,
      workflowId: id,
      workflowName: result.name,
      action: 'published',
      metadata: {
        version: result.version,
        nodesCount: (result.publishedNodes || []).length,
        edgesCount: (result.publishedEdges || []).length,
      },
    });

    return this.decryptWorkflowHeadersForResponse(result);
  }

  async updateStatus(id: string, dto: UpdateWorkflowStatusDto) {
    const existing = await this.repo.findById(this.tenantId, id);
    if (!existing) throw new NotFoundException('Workflow not found');

    // Validate: can't activate without published snapshot
    if (dto.status === 'active') {
      const publishedNodes = (existing as any).publishedNodes || [];
      if (publishedNodes.length === 0) {
        throw new BadRequestException(
          'Workflow must be published before it can be activated. Please publish first.',
        );
      }
    }

    const previousStatus = existing.status;
    const result = await this.repo.updateStatus(this.tenantId, id, dto.status);

    // Audit: status changed
    await this.auditService.logAction({
      tenantId: this.tenantId,
      userId: this.userId,
      workflowId: id,
      workflowName: existing.name,
      action: 'status_changed',
      diff: [{ field: 'status', before: previousStatus, after: dto.status }],
      metadata: { previousStatus, newStatus: dto.status },
    });

    return result ? this.decryptWorkflowHeadersForResponse(result) : result;
  }

  async duplicate(id: string) {
    const result = await this.repo.duplicate(this.tenantId, id, this.userId);
    if (!result) throw new NotFoundException('Workflow not found');
    const migratedResult = await this.migrateWebhookHeadersAtRest(result);

    // Audit: workflow duplicated
    await this.auditService.logAction({
      tenantId: this.tenantId,
      userId: this.userId,
      workflowId: result._id.toString(),
      workflowName: result.name,
      action: 'duplicated',
      metadata: { sourceWorkflowId: id },
    });

    return this.decryptWorkflowHeadersForResponse(migratedResult);
  }

  async delete(id: string) {
    const existing = await this.repo.findById(this.tenantId, id);
    if (!existing) throw new NotFoundException('Workflow not found');

    const deleted = await this.repo.delete(this.tenantId, id);
    if (!deleted) throw new NotFoundException('Workflow not found');

    // Audit: workflow deleted
    await this.auditService.logAction({
      tenantId: this.tenantId,
      userId: this.userId,
      workflowId: id,
      workflowName: existing.name,
      action: 'deleted',
    });
  }

  // Validation

  private validateWorkflow(dto: CreateWorkflowDto): void {
    const { nodes, edges } = dto;

    // Must have exactly one trigger node
    const triggerNodes = nodes.filter(
      (n) => n.type === 'trigger' || n.type === 'triggerNode',
    );
    if (triggerNodes.length === 0) {
      throw new BadRequestException(
        'Workflow must have at least one Trigger node',
      );
    }
    if (triggerNodes.length > 1) {
      throw new BadRequestException('Workflow can only have one Trigger node');
    }

    // Validate condition nodes have valid structure
    const conditionNodes = nodes.filter(
      (n) => n.type === 'condition' || n.type === 'conditionNode',
    );
    for (const cn of conditionNodes) {
      if (cn.config?.rules) {
        const validation = this.conditionEvaluator.validate({
          logic: cn.config.logic ?? 'AND',
          rules: cn.config.rules,
        });
        if (!validation.valid) {
          throw new BadRequestException(
            `Condition node "${cn.config.name || cn.id}" has invalid rules: ${validation.error}`,
          );
        }
      }
    }

    // Validate edges reference existing nodes
    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const edge of edges) {
      if (!nodeIds.has(edge.source)) {
        throw new BadRequestException(
          `Edge ${edge.id} references non-existent source node: ${edge.source}`,
        );
      }
      if (!nodeIds.has(edge.target)) {
        throw new BadRequestException(
          `Edge ${edge.id} references non-existent target node: ${edge.target}`,
        );
      }
    }

    // Reject cyclic graphs. The workflow builder is a DAG (trigger →
    // condition/action → …); a back-edge is a user error that would make the
    // runtime traversal recurse until the Redis strict-loop guard (or stack)
    // stops it. Catching it at save time is cheaper and clearer.
    this.assertNoCycle(nodes, edges);
  }

  /**
   * Validate the parts of a node's `config` the runtime depends on.
   *
   * `WorkflowNodeDto.config` is an unvalidated `Record<string, any>` persisted
   * as Mixed, and `type` is a free string. That deferred every mistake to the
   * worker, where the consequences are invisible to the author:
   *   - an unknown `actionType` is only caught by the queue consumer, which
   *     dead-letters the job;
   *   - an unknown node `type` makes the orchestrator's traversal fall through
   *     and silently truncate that branch;
   *   - a `configId` was never checked to belong to this tenant, which is how a
   *     workflow could point a send_email node at another tenant's credentials.
   *
   * Save time is where these belong: the author is present and can be told.
   */
  private async validateNodeConfigs(
    nodes: any[],
    triggerObject?: string,
  ): Promise<void> {
    if (!Array.isArray(nodes)) return;

    for (const node of nodes) {
      const type = this.normalizeNodeType(node.type);
      if (!type) {
        throw new BadRequestException(
          `Node "${node.id}" has unsupported type "${node.type}". ` +
            `Supported: ${[...SUPPORTED_NODE_TYPES].join(', ')}.`,
        );
      }

      if (type === 'action') {
        this.validateActionNode(node);
        this.assertActionSupportsTriggerObject(node, triggerObject);
      }
      if (type === 'wait') {
        this.validateWaitNode(node);
        this.assertWaitSupportsTriggerObject(node, triggerObject);
      }
    }

    // Grouped after the shape checks so a workflow with a typo does not spend a
    // DB round-trip per node first.
    await this.validateChannelConfigRefs(nodes);
  }

  /** Map both the plain and `*Node` spellings the builder emits. */
  private normalizeNodeType(raw: unknown): SupportedNodeType | null {
    if (typeof raw !== 'string') return null;
    const base = raw.endsWith('Node') ? raw.slice(0, -4) : raw;
    return SUPPORTED_NODE_TYPES.has(base as SupportedNodeType)
      ? (base as SupportedNodeType)
      : null;
  }

  private validateActionNode(node: any): void {
    const actionType = node.config?.actionType;
    if (!actionType) {
      throw new BadRequestException(
        `Action node "${node.config?.name ?? node.id}" is missing actionType.`,
      );
    }
    if (!SUPPORTED_ACTION_TYPES.has(actionType)) {
      throw new BadRequestException(
        `Action node "${node.config?.name ?? node.id}" has unknown actionType ` +
          `"${actionType}". Supported: ${[...SUPPORTED_ACTION_TYPES].join(', ')}.`,
      );
    }
    // Registered (so existing workflows still round-trip and report a clear
    // runtime error) but not buildable: these executors have no integration
    // behind them and used to report a fake success.
    if (NOT_IMPLEMENTED_ACTION_TYPES.has(actionType)) {
      throw new BadRequestException(
        `Action "${actionType}" is not available yet — no provider integration ` +
          'exists for it. Use send_sms or send_livechat instead.',
      );
    }
  }

  /**
   * Conversation and Message records are not reachable through
   * `CrmRecordUpdateService` — `getServiceForModule` has no case for them, so
   * any action that goes through it fails at runtime with "Unsupported module"
   * and lands in the DLQ. Refuse the combination at save time instead, where the
   * author can pick a different action.
   *
   * `route_to_group` is fine: it has a dedicated conversation path through the
   * omni AssignmentService.
   */
  private assertActionSupportsTriggerObject(
    node: any,
    triggerObject?: string,
  ): void {
    if (!triggerObject || !OMNI_TRIGGER_OBJECTS.has(triggerObject)) return;

    const actionType = node.config?.actionType;
    if (!CRM_RECORD_ACTIONS.has(actionType)) return;

    throw new BadRequestException(
      `Action "${actionType}" cannot run on a ${triggerObject} trigger: ` +
        `${triggerObject} records are not writable through the CRM update path. ` +
        'Use "Route to Team", "Create Ticket", "Send Livechat" or a webhook instead.',
    );
  }

  /**
   * A hibernated execution re-fetches its record on resume
   * (`AutomationDelayedProcessor.resumeWorkflow` → `fetchRecord`), which returns
   * null for Conversation/Message and is then reported as RECORD_NOT_FOUND. A
   * wait node on those triggers would therefore always fail after the delay,
   * hours or days later. Refuse it up front.
   */
  private assertWaitSupportsTriggerObject(
    node: any,
    triggerObject?: string,
  ): void {
    if (!triggerObject || !OMNI_TRIGGER_OBJECTS.has(triggerObject)) return;

    throw new BadRequestException(
      `Wait node "${node.config?.name ?? node.id}" is not supported on a ` +
        `${triggerObject} trigger: the execution cannot re-read a ` +
        `${triggerObject} when it resumes, so it would fail after the delay.`,
    );
  }

  private validateWaitNode(node: any): void {
    const { delayValue, delayUnit } = node.config ?? {};
    if (delayUnit !== undefined && !WAIT_UNITS.has(delayUnit)) {
      throw new BadRequestException(
        `Wait node "${node.config?.name ?? node.id}" has unknown delayUnit ` +
          `"${delayUnit}". Supported: ${[...WAIT_UNITS].join(', ')}.`,
      );
    }
    if (
      delayValue !== undefined &&
      (typeof delayValue !== 'number' ||
        !Number.isFinite(delayValue) ||
        delayValue < 1)
    ) {
      throw new BadRequestException(
        `Wait node "${node.config?.name ?? node.id}" needs delayValue to be a ` +
          'positive number.',
      );
    }
  }

  /**
   * Every `configId` a node references must be a channel config owned by THIS
   * tenant. The executors now also guard at send time
   * (TransportPool.resolveWithTenantGuard), but failing at save time is what
   * makes the mistake fixable instead of a silent dead-lettered job.
   */
  private async validateChannelConfigRefs(nodes: any[]): Promise<void> {
    const referenced = new Map<string, string>();
    for (const node of nodes) {
      const configId = node.config?.configId;
      if (typeof configId === 'string' && configId.trim()) {
        referenced.set(configId, node.config?.name ?? node.id);
      }
    }

    for (const [configId, nodeLabel] of referenced) {
      const config = await this.channelConfigRepo.findById(
        this.tenantId,
        configId,
      );
      if (!config) {
        throw new BadRequestException(
          `Node "${nodeLabel}" references channel config "${configId}", which ` +
            'does not exist in this workspace.',
        );
      }
    }
  }

  /**
   * DFS-based cycle detection over workflow edges. Throws BadRequestException
   * naming a node on the offending cycle. O(V + E).
   */
  private assertNoCycle(
    nodes: { id: string }[],
    edges: { source: string; target: string }[],
  ): void {
    const adjacency = new Map<string, string[]>();
    for (const n of nodes) adjacency.set(n.id, []);
    for (const e of edges) adjacency.get(e.source)?.push(e.target);

    // 0 = unvisited, 1 = in current DFS stack, 2 = fully explored
    const state = new Map<string, number>();

    const visit = (nodeId: string): string | null => {
      state.set(nodeId, 1);
      for (const next of adjacency.get(nodeId) ?? []) {
        const s = state.get(next) ?? 0;
        if (s === 1) return next; // back-edge → cycle
        if (s === 0) {
          const found = visit(next);
          if (found) return found;
        }
      }
      state.set(nodeId, 2);
      return null;
    };

    for (const n of nodes) {
      if ((state.get(n.id) ?? 0) === 0) {
        const cycleNode = visit(n.id);
        if (cycleNode) {
          throw new BadRequestException(
            `Workflow contains a cycle (back-edge into node "${cycleNode}"). ` +
              `Automation workflows must be acyclic.`,
          );
        }
      }
    }
  }

  private async migrateWebhookHeadersAtRest(workflow: any): Promise<any> {
    const [draftResult, publishedResult] = await Promise.all([
      this.webhookHeaderCrypto.encryptNodes(workflow.nodes || []),
      this.webhookHeaderCrypto.encryptNodes(workflow.publishedNodes || []),
    ]);

    const update: Record<string, any> = {};
    if (draftResult.changed) update.nodes = draftResult.nodes;
    if (publishedResult.changed) update.publishedNodes = publishedResult.nodes;

    if (Object.keys(update).length > 0) {
      const updatedWorkflow = await this.repo.update(
        this.tenantId,
        workflow._id.toString(),
        update,
      );
      return updatedWorkflow ?? workflow;
    }

    return workflow;
  }

  private async decryptWorkflowHeadersForResponse(workflow: any) {
    return {
      ...workflow,
      nodes: await this.webhookHeaderCrypto.decryptNodesForResponse(
        workflow.nodes || [],
      ),
      publishedNodes: await this.webhookHeaderCrypto.decryptNodesForResponse(
        workflow.publishedNodes || [],
      ),
    };
  }

  private redactWorkflowHeaders(workflow: any) {
    return {
      ...workflow,
      nodes: this.webhookHeaderCrypto.redactNodes(workflow.nodes || []),
      publishedNodes: this.webhookHeaderCrypto.redactNodes(
        workflow.publishedNodes || [],
      ),
    };
  }
}
