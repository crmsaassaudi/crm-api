import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  LeadScoringRuleSchemaClass,
  LeadScoringRuleDocument,
  ScoringCondition,
  ScoringOperator,
} from './lead-scoring-rule.schema';
import { ContactRepository } from '../contacts/infrastructure/persistence/document/repositories/contact.repository';
import {
  ContactSchemaClass,
  ContactSchemaDocument,
} from '../contacts/infrastructure/persistence/document/entities/contact.schema';

export type ScoringTrigger =
  | 'on_create'
  | 'on_update'
  | 'on_activity'
  | 'always';

/** The shape the scorer needs — a lean rule row, not a hydrated document. */
export interface LeadScoringRule {
  condition: ScoringCondition;
  points: number;
}

/**
 * LeadScoringService — rule-based contact score engine.
 *
 * Each tenant defines a set of LeadScoringRules.
 * When a contact is created/updated or an activity event fires,
 * the engine evaluates all active rules and computes a delta score.
 *
 * Score model:
 *   - Per-rule points accumulate. Total is floored at 0.
 *   - Stored in contact.score (existing field).
 *   - No cap — business logic decides thresholds.
 */
@Injectable()
export class LeadScoringService {
  private readonly logger = new Logger(LeadScoringService.name);

  constructor(
    @InjectModel(LeadScoringRuleSchemaClass.name)
    private readonly ruleModel: Model<LeadScoringRuleDocument>,

    @InjectModel(ContactSchemaClass.name)
    private readonly contactModel: Model<ContactSchemaDocument>,

    private readonly contactRepository: ContactRepository,
    private readonly cls: ClsService,
  ) {}

  // CRUD

  async listRules(tenantId: string): Promise<LeadScoringRuleDocument[]> {
    return this.ruleModel
      .find({ tenantId })
      .sort({ sortOrder: 1, createdAt: 1 })
      .exec();
  }

  async createRule(
    tenantId: string,
    dto: Partial<LeadScoringRuleDocument>,
  ): Promise<LeadScoringRuleDocument> {
    const doc = new this.ruleModel({ ...dto, tenantId });
    return doc.save();
  }

  async updateRule(
    tenantId: string,
    ruleId: string,
    dto: Partial<LeadScoringRuleDocument>,
  ): Promise<LeadScoringRuleDocument> {
    const updated = await this.ruleModel
      .findOneAndUpdate({ _id: ruleId, tenantId }, { $set: dto }, { new: true })
      .exec();
    if (!updated) throw new NotFoundException('Lead scoring rule not found');
    return updated;
  }

  async deleteRule(tenantId: string, ruleId: string): Promise<void> {
    await this.ruleModel.deleteOne({ _id: ruleId, tenantId }).exec();
  }

  async toggleRule(
    tenantId: string,
    ruleId: string,
    isActive: boolean,
  ): Promise<LeadScoringRuleDocument> {
    return this.updateRule(tenantId, ruleId, { isActive } as any);
  }

  // Score computation

  /**
   * Re-evaluate all active rules for a specific contact and persist
   * the new aggregated score. Called on contact create/update.
   */
  async scoreContact(
    tenantId: string,
    contactId: string,
    trigger: ScoringTrigger = 'always',
    activityContext?: { type: string; [key: string]: any },
  ): Promise<number> {
    const contact = await this.contactModel
      .findOne({ _id: contactId, tenantId })
      .lean()
      .exec();
    if (!contact) return 0;

    const rules = await this.getActiveRules(tenantId, trigger);
    const newScore = this.computeScore(rules, contact as any, activityContext);

    await this.contactModel
      .updateOne({ _id: contactId, tenantId }, { $set: { score: newScore } })
      .exec();

    this.logger.debug(
      `Scored contact ${contactId}: ${rules.length} rules → ${newScore} pts`,
    );

    return newScore;
  }

  /**
   * The tenant's active rules for a trigger — the input the nightly sweep needs
   * to score a whole page without re-reading the rule set per contact.
   *
   * Runs as a platform query: the caller is a cron with no request context, and
   * the tenant is supplied explicitly.
   */
  async getActiveRules(
    tenantId: string,
    trigger: ScoringTrigger = 'always',
  ): Promise<LeadScoringRule[]> {
    return this.ruleModel
      .find({ tenantId, isActive: true, trigger: { $in: [trigger, 'always'] } })
      .setOptions({ isPlatformQuery: true } as any)
      .lean()
      .exec() as unknown as Promise<LeadScoringRule[]>;
  }

  /**
   * Re-apply the tenant's rules to every one of its contacts.
   *
   * The "apply now" an admin presses after editing rules — the nightly sweep
   * would otherwise be the only thing that reconciles them.
   *
   * Paged with a `_id` cursor and one `bulkWrite` per page. The previous version
   * held a cursor open over the whole collection and issued one `updateOne` per
   * contact, which is a round-trip per row.
   */
  async bulkRescoreForTenant(
    tenantId: string,
  ): Promise<{ scanned: number; updated: number }> {
    const rules = await this.getActiveRules(tenantId);
    if (!rules.length) return { scanned: 0, updated: 0 };

    const PAGE = 1_000;
    let after: Types.ObjectId | undefined;
    let scanned = 0;
    let updated = 0;

    for (;;) {
      const page = await this.contactModel
        .find({
          tenantId,
          deletedAt: null,
          ...(after ? { _id: { $gt: after } } : {}),
        })
        .sort({ _id: 1 })
        .limit(PAGE)
        .lean()
        .exec();
      if (page.length === 0) break;

      const operations = page
        .map((contact) => ({
          contact,
          score: this.computeScore(rules, contact as any),
        }))
        .filter(({ contact, score }) => score !== (contact.score ?? 0))
        .map(({ contact, score }) => ({
          updateOne: {
            filter: { _id: contact._id, tenantId },
            update: { $set: { score } },
          },
        }));

      if (operations.length) {
        const result = await this.contactModel.bulkWrite(operations as any, {
          ordered: false,
        });
        updated += result.modifiedCount;
      }

      scanned += page.length;
      after = page[page.length - 1]._id as unknown as Types.ObjectId;
      if (page.length < PAGE) break;
    }

    return { scanned, updated };
  }

  /**
   * The tenant's score for one contact, given its rules. Pure — no I/O.
   *
   * This is THE score function. It used to have a rival: a hard-coded
   * recency+completeness formula inside ContactRepository that the nightly cron
   * applied to every contact in every tenant, overwriting whatever the rules had
   * produced. A tenant's Lead Scoring screen therefore described a calculation
   * that survived only until 02:00, and `score` — a sortable, filterable,
   * reportable field — meant whichever writer ran last.
   */
  computeScore(
    rules: LeadScoringRule[],
    contact: Record<string, any>,
    activityContext?: Record<string, any>,
  ): number {
    let totalPoints = 0;
    for (const rule of rules) {
      if (this.evaluateCondition(rule.condition, contact, activityContext)) {
        totalPoints += rule.points;
      }
    }
    return Math.max(0, totalPoints);
  }

  // Event listeners

  @OnEvent('contact.updated')
  async onContactUpdated(payload: { tenantId: string; contactId: string }) {
    try {
      await this.scoreContact(payload.tenantId, payload.contactId, 'on_update');
    } catch (err) {
      this.logger.warn(`Failed to score contact ${payload.contactId}: ${err}`);
    }
  }

  @OnEvent('contact.created')
  async onContactCreated(payload: { tenantId: string; contactId: string }) {
    try {
      await this.scoreContact(payload.tenantId, payload.contactId, 'on_create');
    } catch (err) {
      this.logger.warn(
        `Failed to score new contact ${payload.contactId}: ${err}`,
      );
    }
  }

  @OnEvent('activity.created')
  async onActivityCreated(payload: {
    tenantId: string;
    contactId?: string;
    activityType: string;
    data?: any;
  }) {
    if (!payload.contactId) return;
    try {
      await this.scoreContact(
        payload.tenantId,
        payload.contactId,
        'on_activity',
        { type: payload.activityType, ...payload.data },
      );
    } catch (err) {
      this.logger.warn(`Failed to score contact on activity: ${err}`);
    }
  }

  // Condition evaluator

  private evaluateCondition(
    condition: ScoringCondition,
    contact: Record<string, any>,
    activityContext?: Record<string, any>,
  ): boolean {
    const { field, operator, value, customFieldKey } = condition;

    let actual: any;

    if (field === 'activity.type') {
      actual = activityContext?.type;
    } else if (field === 'customFields' && customFieldKey) {
      actual = contact.customFields?.[customFieldKey];
    } else {
      actual = contact[field];
    }

    return this.applyOperator(operator, actual, value);
  }

  private applyOperator(
    operator: ScoringOperator,
    actual: any,
    expected?: any,
  ): boolean {
    switch (operator) {
      case 'exists':
        return (
          actual !== undefined &&
          actual !== null &&
          actual !== '' &&
          !(Array.isArray(actual) && actual.length === 0)
        );

      case 'not_exists':
        return (
          actual === undefined ||
          actual === null ||
          actual === '' ||
          (Array.isArray(actual) && actual.length === 0)
        );

      case 'equals':
        if (Array.isArray(actual)) return actual.includes(String(expected));
        return String(actual) === String(expected);

      case 'not_equals':
        if (Array.isArray(actual)) return !actual.includes(String(expected));
        return String(actual) !== String(expected);

      case 'contains':
        if (Array.isArray(actual))
          return actual.some((v) => String(v).includes(String(expected)));
        return String(actual ?? '')
          .toLowerCase()
          .includes(String(expected).toLowerCase());

      case 'not_contains':
        if (Array.isArray(actual))
          return !actual.some((v) => String(v).includes(String(expected)));
        return !String(actual ?? '')
          .toLowerCase()
          .includes(String(expected).toLowerCase());

      case 'greater_than':
        return Number(actual) > Number(expected);

      case 'less_than':
        return Number(actual) < Number(expected);

      default:
        return false;
    }
  }
}
