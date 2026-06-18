import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
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

  // ── CRUD ────────────────────────────────────────────────────────────────

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

  // ── Score computation ────────────────────────────────────────────────────

  /**
   * Re-evaluate all active rules for a specific contact and persist
   * the new aggregated score. Called on contact create/update.
   */
  async scoreContact(
    tenantId: string,
    contactId: string,
    trigger: 'on_create' | 'on_update' | 'on_activity' | 'always' = 'always',
    activityContext?: { type: string; [key: string]: any },
  ): Promise<number> {
    const contact = await this.contactModel
      .findOne({ _id: contactId, tenantId })
      .lean()
      .exec();
    if (!contact) return 0;

    const rules = await this.ruleModel
      .find({
        tenantId,
        isActive: true,
        trigger: { $in: [trigger, 'always'] },
      })
      .lean()
      .exec();

    let totalPoints = 0;
    for (const rule of rules) {
      const matches = this.evaluateCondition(
        rule.condition as ScoringCondition,
        contact as any,
        activityContext,
      );
      if (matches) {
        totalPoints += rule.points;
      }
    }

    // Floor at 0 — score never goes negative
    const newScore = Math.max(0, totalPoints);

    await this.contactModel
      .updateOne({ _id: contactId, tenantId }, { $set: { score: newScore } })
      .exec();

    this.logger.debug(
      `Scored contact ${contactId}: ${rules.length} rules → ${newScore} pts`,
    );

    return newScore;
  }

  /**
   * Bulk re-score all contacts for a tenant (background job).
   * Returns stats: scanned / updated.
   */
  async bulkRescoreForTenant(
    tenantId: string,
  ): Promise<{ scanned: number; updated: number }> {
    const rules = await this.ruleModel
      .find({ tenantId, isActive: true })
      .lean()
      .exec();

    if (!rules.length) return { scanned: 0, updated: 0 };

    const cursor = this.contactModel.find({ tenantId }).lean().cursor();
    let scanned = 0;
    let updated = 0;

    for await (const contact of cursor) {
      scanned++;
      let totalPoints = 0;
      for (const rule of rules) {
        if (
          this.evaluateCondition(
            rule.condition as ScoringCondition,
            contact as any,
          )
        ) {
          totalPoints += rule.points;
        }
      }
      const newScore = Math.max(0, totalPoints);
      if (newScore !== (contact.score ?? 0)) {
        await this.contactModel
          .updateOne({ _id: contact._id }, { $set: { score: newScore } })
          .exec();
        updated++;
      }
    }

    return { scanned, updated };
  }

  // ── Event listeners ──────────────────────────────────────────────────────

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

  // ── Condition evaluator ──────────────────────────────────────────────────

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

    return this.applyOperator(operator as ScoringOperator, actual, value);
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
