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
  ) {}

  private get tenantId(): string {
    return this.cls.get('tenantId');
  }

  private get userId(): string {
    return this.cls.get('user.id') || 'system';
  }

  // ── Queries ────────────────────────────────────────────────────────────

  async findAll() {
    return this.repo.findAll(this.tenantId);
  }

  async findById(id: string) {
    const workflow = await this.repo.findById(this.tenantId, id);
    if (!workflow) throw new NotFoundException('Workflow not found');
    return workflow;
  }

  async findByStatus(status: 'draft' | 'active' | 'paused') {
    return this.repo.findByStatus(this.tenantId, status);
  }

  // ── Mutations ──────────────────────────────────────────────────────────

  async create(dto: CreateWorkflowDto) {
    this.validateWorkflow(dto);

    const result = await this.repo.create({
      tenantId: this.tenantId,
      name: dto.name,
      description: dto.description || '',
      status: 'draft',
      triggerConfig: dto.triggerConfig as any,
      nodes: dto.nodes as any,
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

    return result;
  }

  async update(id: string, dto: UpdateWorkflowDto) {
    const existing = await this.repo.findById(this.tenantId, id);
    if (!existing) throw new NotFoundException('Workflow not found');

    // ── Optimistic Concurrency Control ──────────────────────────────────
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

    // Strip updatedAt from the payload — Mongoose timestamps: true handles it
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { updatedAt: _clientTs, ...updateData } = dto;

    // Compute diff for audit
    const diff = this.auditService.computeDiff(existing as any, updateData);

    const result = await this.repo.update(this.tenantId, id, {
      ...updateData,
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

    return result;
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

    return result;
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

    return result;
  }

  async duplicate(id: string) {
    const result = await this.repo.duplicate(this.tenantId, id, this.userId);
    if (!result) throw new NotFoundException('Workflow not found');

    // Audit: workflow duplicated
    await this.auditService.logAction({
      tenantId: this.tenantId,
      userId: this.userId,
      workflowId: result._id.toString(),
      workflowName: result.name,
      action: 'duplicated',
      metadata: { sourceWorkflowId: id },
    });

    return result;
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

  // ── Validation ─────────────────────────────────────────────────────────

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
          logic: cn.config.logic || 'AND',
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
  }
}
