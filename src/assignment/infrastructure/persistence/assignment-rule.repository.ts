import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  AssignmentRuleDocument,
  AssignmentRuleSchemaClass,
} from './assignment-rule.schema';
import {
  AssignmentRule,
  normalizeRuleActions,
} from '../../domain/assignment-rule';
import { AssignmentObjectType, MatchType } from '../../domain/assignment.types';
import { ConditionOperator } from '../../domain/assignment.types';

@Injectable()
export class AssignmentRuleRepository {
  constructor(
    @InjectModel(AssignmentRuleSchemaClass.name)
    private readonly model: Model<AssignmentRuleDocument>,
  ) {}

  /**
   * Map a persisted document onto the domain type, normalising the action shape
   * on the way through so a half-migrated document cannot reach the decision
   * pipeline with a team the evaluator would ignore.
   */
  private toDomain(doc: any): AssignmentRule {
    return {
      id: String(doc._id),
      tenantId: String(doc.tenantId),
      objectType: doc.objectType as AssignmentObjectType,
      name: doc.name,
      description: doc.description ?? null,
      priority: doc.priority ?? 0,
      matchType: (doc.matchType ?? 'all') as MatchType,
      conditions: (doc.conditions ?? []).map((c: any) => ({
        field: c.field,
        operator: c.operator as ConditionOperator,
        value: c.value ?? '',
      })),
      actions: normalizeRuleActions(doc.actions),
      enabled: doc.enabled !== false,
    };
  }

  async findEnabled(
    tenantId: string,
    objectType: AssignmentObjectType,
  ): Promise<AssignmentRule[]> {
    const docs = await this.model
      .find({ tenantId, objectType, enabled: true })
      .sort({ priority: 1, _id: 1 })
      .lean()
      .exec();
    return docs.map((d) => this.toDomain(d));
  }

  async findAll(
    tenantId: string,
    objectType?: AssignmentObjectType,
  ): Promise<AssignmentRule[]> {
    const filter: Record<string, unknown> = { tenantId };
    if (objectType) filter.objectType = objectType;
    const docs = await this.model
      .find(filter)
      .sort({ objectType: 1, priority: 1, _id: 1 })
      .lean()
      .exec();
    return docs.map((d) => this.toDomain(d));
  }

  async findById(tenantId: string, id: string): Promise<AssignmentRule | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await this.model.findOne({ _id: id, tenantId }).lean().exec();
    return doc ? this.toDomain(doc) : null;
  }

  async create(
    tenantId: string,
    data: Partial<AssignmentRuleSchemaClass>,
  ): Promise<AssignmentRule> {
    const doc = await this.model.create({ ...data, tenantId });
    return this.toDomain(doc.toObject());
  }

  async update(
    tenantId: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<AssignmentRule> {
    const doc = await this.model
      .findOneAndUpdate({ _id: id, tenantId }, { $set: data }, { new: true })
      .lean()
      .exec();
    if (!doc) throw new NotFoundException('Assignment rule not found');
    return this.toDomain(doc);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const res = await this.model.deleteOne({ _id: id, tenantId }).exec();
    if (res.deletedCount === 0) {
      throw new NotFoundException('Assignment rule not found');
    }
  }

  /** Next free priority for a new rule of this objectType. */
  async nextPriority(
    tenantId: string,
    objectType: AssignmentObjectType,
  ): Promise<number> {
    return this.model.countDocuments({ tenantId, objectType }).exec();
  }

  /**
   * Reorder within one objectType. Scoping the write to the objectType prevents
   * an id from another tab being smuggled into the ordered list and silently
   * re-prioritised.
   */
  async reorder(
    tenantId: string,
    objectType: AssignmentObjectType,
    orderedIds: string[],
  ): Promise<void> {
    const valid = orderedIds.filter((id) => Types.ObjectId.isValid(id));
    if (valid.length === 0) return;
    await this.model.bulkWrite(
      valid.map((id, idx) => ({
        updateOne: {
          filter: { _id: new Types.ObjectId(id), tenantId, objectType },
          update: { $set: { priority: idx } },
        },
      })),
    );
  }

  async countByGroup(tenantId: string, groupId: string): Promise<number> {
    return this.model
      .countDocuments({ tenantId, 'actions.groupIds': groupId })
      .exec();
  }
}
