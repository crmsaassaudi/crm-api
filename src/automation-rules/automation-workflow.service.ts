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
import { ListWorkflowsQueryDto } from './dto/list-workflows-query.dto';
import { ConditionEvaluatorService } from './engine/condition-evaluator.service';
import { AutomationAuditService } from './automation-audit.service';
import { WebhookHeaderCryptoService } from './engine/webhook-header-crypto.service';
import { ChannelConfigRepository } from '../channels/infrastructure/persistence/document/repositories/channel-config.repository';
import { AuthorizationService } from '../common/permissions/authorization.service';
import { DEFAULT_RUN_AS, WorkflowRunAs } from './domain/execution-principal';
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_ACTION_TYPE_SET,
} from './queue/automation-queue.constants';
import { OMNI_TRIGGER_OBJECTS } from './domain/trigger-catalog';

/** Node types the orchestrator's traversal handles. */
const SUPPORTED_NODE_TYPES = new Set([
  'trigger',
  'condition',
  'action',
  'wait',
] as const);
type SupportedNodeType = 'trigger' | 'condition' | 'action' | 'wait';

const WAIT_UNITS = new Set(['minutes', 'hours', 'days']);

/** Actions that write through CrmRecordUpdateService / a CRM record service. */
const CRM_RECORD_ACTIONS = new Set([
  'update_field',
  'add_tag',
  'remove_tag',
  'add_note',
]);

/**
 * Actions that must name a tenant channel config.
 *
 * There is no platform-wide sender to fall back to any more, so a send action
 * without a `configId` cannot deliver anything. Refusing at save time is the
 * difference between an author seeing the problem and a customer message
 * silently dead-lettering days later.
 */
const CONFIG_REQUIRED_ACTIONS = new Set(['send_email', 'send_sms']);

/**
 * AutomationWorkflowService — business logic for workflow CRUD.
 *
 * Validates workflow structure before saving, ensures tenant isolation via CLS
 * context, provides duplicate/publish functionality, and logs every lifecycle
 * action to the audit trail.
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
   * payload, which has `sub` and no `id`.
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
   * rewrite every record in the tenant.
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

  async findAll(filters: ListWorkflowsQueryDto = {}) {
    const workflows = await this.repo.findAll(this.tenantId, filters);
    return workflows.map((workflow) => this.redactWorkflowHeaders(workflow));
  }

  async findById(id: string) {
    const workflow = await this.repo.findById(this.tenantId, id);
    if (!workflow) throw new NotFoundException('Workflow not found');
    return this.decryptWorkflowHeadersForResponse(workflow);
  }

  // Mutations

  async create(dto: CreateWorkflowDto) {
    this.validateWorkflow(dto);
    const runAs = dto.runAs ?? DEFAULT_RUN_AS;
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

    // Optimistic concurrency control: if the client sends updatedAt, verify it
    // matches the DB timestamp so two admins editing at once do not silently
    // overwrite each other.
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
      this.validateWorkflow({
        nodes: dto.nodes ?? (existing as any).nodes,
        edges: dto.edges ?? (existing as any).edges,
      } as any);
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

    // updatedAt is stripped — Mongoose `timestamps: true` owns it.
    const { updatedAt: _clientTs, ...updateData } = dto;
    const persistData: Record<string, any> = { ...updateData };

    if (updateData.nodes) {
      const encrypted = await this.webhookHeaderCrypto.encryptNodes(
        updateData.nodes as any,
      );
      persistData.nodes = encrypted.nodes;
    }

    const diff = this.auditService.computeDiff(existing, persistData);

    const result = await this.repo.update(this.tenantId, id, {
      ...persistData,
      updatedBy: this.userId,
    } as any);

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

    const nodes = existing.nodes || [];
    const hasTrigger = nodes.some((n: any) => n.type === 'trigger');
    const hasAction = nodes.some((n: any) => n.type === 'action');

    if (!hasTrigger || !hasAction) {
      throw new BadRequestException(
        'Workflow must have at least a Trigger node and one Action node to be published',
      );
    }

    // Publishing is what makes a graph executable, so the full structural and
    // per-node validation runs again here rather than trusting whatever the last
    // partial PATCH happened to check.
    this.validateWorkflow(existing as any);
    await this.validateNodeConfigs(
      nodes as any[],
      (existing as any).triggerConfig?.object,
    );
    this.assertNoOrphanNodes(nodes as any[], (existing.edges ?? []) as any[]);

    const result = await this.repo.publish(this.tenantId, id);
    if (!result) throw new NotFoundException('Workflow not found');

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

    await this.auditService.logAction({
      tenantId: this.tenantId,
      userId: this.userId,
      workflowId: result._id.toString(),
      workflowName: result.name,
      action: 'duplicated',
      metadata: { sourceWorkflowId: id },
    });

    return this.decryptWorkflowHeadersForResponse(result);
  }

  async delete(id: string) {
    const existing = await this.repo.findById(this.tenantId, id);
    if (!existing) throw new NotFoundException('Workflow not found');

    const deleted = await this.repo.delete(this.tenantId, id);
    if (!deleted) throw new NotFoundException('Workflow not found');

    await this.auditService.logAction({
      tenantId: this.tenantId,
      userId: this.userId,
      workflowId: id,
      workflowName: existing.name,
      action: 'deleted',
    });
  }

  // Validation

  private validateWorkflow(dto: {
    nodes: CreateWorkflowDto['nodes'];
    edges: CreateWorkflowDto['edges'];
  }): void {
    const { nodes, edges } = dto;

    const triggerNodes = nodes.filter((n) => n.type === 'trigger');
    if (triggerNodes.length === 0) {
      throw new BadRequestException(
        'Workflow must have at least one Trigger node',
      );
    }
    if (triggerNodes.length > 1) {
      throw new BadRequestException('Workflow can only have one Trigger node');
    }

    for (const cn of nodes.filter((n) => n.type === 'condition')) {
      this.validateConditionNode(cn);
    }

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

    this.assertEdgeHandlesMatchSource(nodes, edges);

    // Reject cyclic graphs. The workflow builder is a DAG; a back-edge is a user
    // error that would make the runtime traversal recurse until the Redis
    // strict-loop guard stops it. Catching it at save time is cheaper and clearer.
    this.assertNoCycle(nodes, edges);
  }

  /**
   * A condition node with no rules evaluates to `true` at runtime — a node the
   * author thinks is a filter but which lets everything through. Requiring at
   * least one rule at save time is the only place that mistake is visible.
   */
  private validateConditionNode(node: {
    id: string;
    config?: Record<string, any>;
  }): void {
    const rules = node.config?.rules;
    const label = node.config?.name || node.id;

    if (!Array.isArray(rules) || rules.length === 0) {
      throw new BadRequestException(
        `Condition node "${label}" has no rules. A condition with no rules ` +
          'matches every record, which is never what a filter is for — add a ' +
          'rule or delete the node.',
      );
    }

    const validation = this.conditionEvaluator.validate({
      logic: node.config?.logic ?? 'AND',
      rules,
    });
    if (!validation.valid) {
      throw new BadRequestException(
        `Condition node "${label}" has invalid rules: ${validation.error}`,
      );
    }
  }

  /**
   * An edge's `sourceHandle` must be one the source node actually produces.
   *
   * `matched`/`not_matched` come from a condition; `success`/`failure` come from
   * an action. Attaching a condition handle to an action node (or vice versa)
   * produced an edge the traversal silently never follows — a branch drawn on the
   * canvas that cannot run.
   */
  private assertEdgeHandlesMatchSource(
    nodes: CreateWorkflowDto['nodes'],
    edges: CreateWorkflowDto['edges'],
  ): void {
    const typeById = new Map(nodes.map((n) => [n.id, n.type]));
    const allowed: Record<string, Set<string>> = {
      condition: new Set(['matched', 'not_matched']),
      action: new Set(['success', 'failure']),
    };

    for (const edge of edges) {
      if (!edge.sourceHandle) continue;
      const sourceType = typeById.get(edge.source);
      const permitted = allowed[sourceType ?? ''];
      if (!permitted || !permitted.has(edge.sourceHandle)) {
        throw new BadRequestException(
          `Edge ${edge.id} leaves a "${sourceType}" node through handle ` +
            `"${edge.sourceHandle}", which that node type does not have. ` +
            `Condition nodes branch on matched/not_matched; action nodes on success/failure.`,
        );
      }
    }
  }

  /**
   * Every non-trigger node must be reachable from the trigger.
   *
   * An unconnected node is silently never executed. Checked at publish time
   * rather than on every draft save, because a half-built graph legitimately has
   * dangling nodes while the author is still working.
   */
  private assertNoOrphanNodes(
    nodes: { id: string; type: string }[],
    edges: { source: string; target: string }[],
  ): void {
    const trigger = nodes.find((n) => n.type === 'trigger');
    if (!trigger) return;

    const adjacency = new Map<string, string[]>();
    for (const e of edges) {
      adjacency.set(e.source, [...(adjacency.get(e.source) ?? []), e.target]);
    }

    const reachable = new Set<string>([trigger.id]);
    const queue = [trigger.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of adjacency.get(current) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }

    const orphans = nodes.filter((n) => !reachable.has(n.id));
    if (orphans.length > 0) {
      throw new BadRequestException(
        `${orphans.length} node(s) are not connected to the trigger and would ` +
          `never run: ${orphans.map((n) => n.id).join(', ')}. Connect or delete them.`,
      );
    }
  }

  /**
   * Validate the parts of a node's `config` the runtime depends on.
   *
   * `WorkflowNodeDto.config` is an unvalidated `Record<string, any>` persisted as
   * Mixed, so without this every mistake is deferred to the worker, where the
   * consequences are invisible to the author: an unknown `actionType` is only
   * caught by the queue consumer, which dead-letters the job, and a `configId`
   * belonging to another tenant would only fail at send time.
   */
  private async validateNodeConfigs(
    nodes: any[],
    triggerObject?: string,
  ): Promise<void> {
    if (!Array.isArray(nodes)) return;

    for (const node of nodes) {
      const type = node.type as SupportedNodeType;
      if (!SUPPORTED_NODE_TYPES.has(type)) {
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

  private validateActionNode(node: any): void {
    const actionType = node.config?.actionType;
    const label = node.config?.name ?? node.id;

    if (!actionType) {
      throw new BadRequestException(
        `Action node "${label}" is missing actionType.`,
      );
    }
    if (!AUTOMATION_ACTION_TYPE_SET.has(actionType)) {
      throw new BadRequestException(
        `Action node "${label}" has unknown actionType "${actionType}". ` +
          `Supported: ${AUTOMATION_ACTION_TYPES.join(', ')}.`,
      );
    }
    if (CONFIG_REQUIRED_ACTIONS.has(actionType) && !node.config?.configId) {
      throw new BadRequestException(
        `Action node "${label}" (${actionType}) must select a channel config — ` +
          'messages are sent with the credentials of the config you pick, and ' +
          'there is no shared sender.',
      );
    }
  }

  /**
   * Conversation and Message records are not reachable through
   * `CrmRecordUpdateService` — `getServiceForModule` has no case for them, so any
   * action that goes through it fails at runtime with "Unsupported module" and
   * lands in the DLQ.
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
   * A hibernated execution re-reads its record on resume, which returns null for
   * Conversation/Message. A wait node on those triggers would therefore always
   * fail after the delay, hours or days later.
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
   * tenant.
   *
   * One query for all of them. This used to await a `findById` per referenced
   * config in a loop, so a workflow with eight send nodes paid eight sequential
   * round-trips on every single save.
   */
  private async validateChannelConfigRefs(nodes: any[]): Promise<void> {
    const labelByConfigId = new Map<string, string>();
    for (const node of nodes) {
      const configId = node.config?.configId;
      if (typeof configId === 'string' && configId.trim()) {
        labelByConfigId.set(configId, node.config?.name ?? node.id);
      }
    }
    if (labelByConfigId.size === 0) return;

    const found = await this.channelConfigRepo.findByIds(this.tenantId, [
      ...labelByConfigId.keys(),
    ]);
    const foundIds = new Set(found.map((c: any) => String(c.id ?? c._id)));

    for (const [configId, nodeLabel] of labelByConfigId) {
      if (!foundIds.has(configId)) {
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
