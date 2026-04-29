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

/**
 * AutomationWorkflowService — business logic for workflow CRUD.
 *
 * Validates workflow structure before saving, ensures tenant isolation
 * via CLS context, and provides duplicate functionality.
 */
@Injectable()
export class AutomationWorkflowService {
  private readonly logger = new Logger(AutomationWorkflowService.name);

  constructor(
    private readonly repo: AutomationWorkflowRepository,
    private readonly cls: ClsService,
    private readonly conditionEvaluator: ConditionEvaluatorService,
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

    return this.repo.create({
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
      createdBy: this.userId,
      updatedBy: this.userId,
    });
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

    return this.repo.update(this.tenantId, id, {
      ...updateData,
      updatedBy: this.userId,
    } as any);
  }

  async updateStatus(id: string, dto: UpdateWorkflowStatusDto) {
    const existing = await this.repo.findById(this.tenantId, id);
    if (!existing) throw new NotFoundException('Workflow not found');

    // Validate that the workflow has at least a trigger + 1 action before activating
    if (dto.status === 'active') {
      const nodes = existing.nodes || [];
      const hasTrigger = nodes.some(
        (n: any) => n.type === 'trigger' || n.type === 'triggerNode',
      );
      const hasAction = nodes.some(
        (n: any) => n.type === 'action' || n.type === 'actionNode',
      );

      if (!hasTrigger || !hasAction) {
        throw new BadRequestException(
          'Workflow must have at least a Trigger node and one Action node to be activated',
        );
      }
    }

    return this.repo.updateStatus(this.tenantId, id, dto.status);
  }

  async duplicate(id: string) {
    const result = await this.repo.duplicate(this.tenantId, id, this.userId);
    if (!result) throw new NotFoundException('Workflow not found');
    return result;
  }

  async delete(id: string) {
    const deleted = await this.repo.delete(this.tenantId, id);
    if (!deleted) throw new NotFoundException('Workflow not found');
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
