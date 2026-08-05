import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AutomationWorkflowRepository } from '../infrastructure/persistence/document/repositories/automation-workflow.repository';
import {
  ConditionEvaluatorService,
  ConditionGroup,
} from './condition-evaluator.service';
import { TemplateInterpolationService } from './template-interpolation.service';
import { CrmRecordUpdateService } from './crm-record-update.service';
import { AutomationCrmModule } from '../events/automation-event.payload';

/** Hard cap so a malformed graph cannot spin the request thread. */
const MAX_DRY_RUN_STEPS = 200;

/** Template-bearing config keys, per action type, previewed in the trace. */
const PREVIEW_FIELDS: Record<string, string[]> = {
  send_email: ['subject', 'template'],
  send_sms: ['message'],
  send_livechat: ['message'],
  internal_notification: ['title', 'message'],
  create_task: ['title', 'description'],
  create_ticket: ['subject', 'description'],
  add_note: ['content'],
  update_field: ['targetField', 'targetValue'],
  webhook: ['webhookUrl', 'bodyTemplate'],
  http_request: ['url', 'bodyTemplate'],
};

export interface DryRunStep {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  /** `taken` for a path that would run, `not_taken` for the branch skipped. */
  outcome: 'taken' | 'not_taken';
  /** Condition nodes: which branch matched. */
  branch?: 'matched' | 'not_matched';
  /** Action nodes: what would have been sent/written, after interpolation. */
  preview?: Record<string, unknown>;
  /** Wait nodes: how long the real execution would pause. */
  delayMs?: number;
  /** Anything the author should know before publishing. */
  warnings?: string[];
}

export interface DryRunResult {
  workflowId: string;
  workflowName: string;
  /** Which graph was walked. Dry-run always tests the DRAFT, not the snapshot. */
  source: 'draft';
  sampleRecordId: string | null;
  steps: DryRunStep[];
  /** Action nodes that would have executed, in order. */
  actionsThatWouldRun: string[];
  truncated: boolean;
}

/**
 * Execute a workflow's logic without performing any side effect.
 *
 * Evaluated for real: every condition (against real or supplied record data),
 * branch selection, and template interpolation. Not done: dispatching a job,
 * writing a record, calling an endpoint, waiting. Action nodes report the payload
 * they *would* have produced, and traversal continues down their `success` branch
 * because there is no outcome to observe.
 *
 * Without this, trying a workflow means publishing it and mailing real customers.
 */
@Injectable()
export class WorkflowDryRunService {
  private readonly logger = new Logger(WorkflowDryRunService.name);

  constructor(
    private readonly workflowRepo: AutomationWorkflowRepository,
    private readonly conditionEvaluator: ConditionEvaluatorService,
    private readonly templateEngine: TemplateInterpolationService,
    private readonly crmRecord: CrmRecordUpdateService,
    private readonly cls: ClsService,
  ) {}

  private get tenantId(): string {
    return this.cls.get('tenantId');
  }

  async run(
    workflowId: string,
    input: { recordId?: string; sampleData?: Record<string, any> },
  ): Promise<DryRunResult> {
    const workflow = await this.workflowRepo.findById(
      this.tenantId,
      workflowId,
    );
    if (!workflow) throw new NotFoundException('Workflow not found');

    const nodes: any[] = (workflow as any).nodes ?? [];
    const edges: any[] = (workflow as any).edges ?? [];
    const trigger = nodes.find((n) => n.type === 'trigger');
    if (!trigger) {
      throw new BadRequestException(
        'Workflow has no trigger node, so there is nothing to test.',
      );
    }

    const recordData = await this.resolveSampleData(workflow, input);

    const edgeMap = new Map<string, any[]>();
    for (const e of edges) {
      edgeMap.set(e.source, [...(edgeMap.get(e.source) ?? []), e]);
    }
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    const steps: DryRunStep[] = [];
    const actionsThatWouldRun: string[] = [];
    let truncated = false;

    const walk = (nodeId: string, taken: boolean): void => {
      if (steps.length >= MAX_DRY_RUN_STEPS) {
        truncated = true;
        return;
      }
      const node = nodeMap.get(nodeId);
      if (!node) return;

      const outgoing = edgeMap.get(nodeId) ?? [];
      const outcome: DryRunStep['outcome'] = taken ? 'taken' : 'not_taken';

      if (node.type === 'condition') {
        const matched = taken
          ? this.conditionEvaluator.evaluate(
              node.config as ConditionGroup,
              recordData,
            )
          : false;
        const branch = matched ? 'matched' : 'not_matched';
        steps.push({
          nodeId,
          nodeName: node.config?.name ?? 'Condition',
          nodeType: 'condition',
          outcome,
          branch: taken ? branch : undefined,
        });
        for (const edge of outgoing) {
          const edgeTaken =
            taken &&
            (edge.sourceHandle ? edge.sourceHandle === branch : matched);
          walk(edge.target, edgeTaken);
        }
        return;
      }

      if (node.type === 'action') {
        const actionType = node.config?.actionType;
        const step: DryRunStep = {
          nodeId,
          nodeName: node.config?.name ?? actionType ?? 'Action',
          nodeType: 'action',
          outcome,
          preview: taken
            ? this.previewAction(node.config, recordData)
            : undefined,
          warnings: taken
            ? this.warnAboutAction(node.config, recordData)
            : undefined,
        };
        steps.push(step);
        if (taken && actionType) actionsThatWouldRun.push(actionType);

        for (const edge of outgoing) {
          // No outcome exists to branch on, so the success path is the one
          // walked; the failure path is reported as not taken so the author can
          // still see it is wired.
          const edgeTaken =
            taken && (!edge.sourceHandle || edge.sourceHandle === 'success');
          walk(edge.target, edgeTaken);
        }
        return;
      }

      if (node.type === 'wait') {
        steps.push({
          nodeId,
          nodeName: node.config?.name ?? 'Wait',
          nodeType: 'wait',
          outcome,
          delayMs: taken ? this.previewDelayMs(node.config) : undefined,
        });
        for (const edge of outgoing) walk(edge.target, taken);
        return;
      }

      // Trigger
      steps.push({
        nodeId,
        nodeName: 'Trigger',
        nodeType: 'trigger',
        outcome,
      });
      for (const edge of outgoing) walk(edge.target, taken);
    };

    walk(trigger.id, true);

    return {
      workflowId,
      workflowName: workflow.name,
      source: 'draft',
      sampleRecordId: input.recordId ?? null,
      steps,
      actionsThatWouldRun,
      truncated,
    };
  }

  /**
   * Prefer a real record: interpolation and conditions only tell the truth
   * against the shape of data the workflow will actually see. `sampleData` is the
   * fallback for testing before any matching record exists.
   */
  private async resolveSampleData(
    workflow: any,
    input: { recordId?: string; sampleData?: Record<string, any> },
  ): Promise<Record<string, any>> {
    if (input.recordId) {
      const recordType: AutomationCrmModule = workflow.triggerConfig?.object;
      const record = await this.crmRecord.fetchRecord(
        recordType,
        input.recordId,
      );
      if (!record) {
        throw new BadRequestException(
          `No ${recordType} with id ${input.recordId} is visible to you.`,
        );
      }
      return record;
    }

    if (input.sampleData) return input.sampleData;

    throw new BadRequestException(
      'Provide either recordId (test against a real record) or sampleData.',
    );
  }

  private previewAction(
    config: Record<string, any> | undefined,
    recordData: Record<string, any>,
  ): Record<string, unknown> {
    const actionType = config?.actionType;
    const fields = PREVIEW_FIELDS[actionType] ?? [];
    const preview: Record<string, unknown> = { actionType };

    for (const field of fields) {
      const raw = config?.[field];
      preview[field] =
        typeof raw === 'string'
          ? this.templateEngine.interpolate(raw, recordData)
          : raw;
    }
    return preview;
  }

  /**
   * Problems that are legal to save but will fail or surprise at run time.
   *
   * Unresolved tokens are the common one: `{{contct.name}}` renders as an empty
   * string, so the customer gets "Hello ," and nothing in the execution log says
   * why.
   */
  private warnAboutAction(
    config: Record<string, any> | undefined,
    recordData: Record<string, any>,
  ): string[] | undefined {
    const warnings: string[] = [];
    const actionType = config?.actionType;

    for (const field of PREVIEW_FIELDS[actionType] ?? []) {
      const raw = config?.[field];
      if (typeof raw !== 'string') continue;
      // Validated against the sample record, not an empty object: the point is
      // which tokens this workflow cannot resolve for real data.
      const check = this.templateEngine.validate(raw, recordData);
      if (check.unresolvedTokens.length > 0) {
        warnings.push(
          `${field}: unresolved token(s) ${check.unresolvedTokens
            .map((t) => `{{${t}}}`)
            .join(', ')} — they will render as empty text.`,
        );
      }
    }

    return warnings.length > 0 ? warnings : undefined;
  }

  private previewDelayMs(config: Record<string, any> | undefined): number {
    const unitMs: Record<string, number> = {
      minutes: 60_000,
      hours: 3_600_000,
      days: 86_400_000,
    };
    const value = Math.max(1, Number(config?.delayValue) || 1);
    return value * (unitMs[config?.delayUnit] ?? unitMs.minutes);
  }
}
