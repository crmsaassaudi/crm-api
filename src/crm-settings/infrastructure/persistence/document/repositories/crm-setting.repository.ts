import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CrmSettingSchemaClass,
  CrmSettingSchemaDocument,
} from '../entities/crm-setting.schema';
import { CrmSetting } from '../../../../domain/crm-setting';
import { CrmSettingMapper } from '../mappers/crm-setting.mapper';

@Injectable()
export class CrmSettingRepository {
  constructor(
    @InjectModel(CrmSettingSchemaClass.name)
    private readonly model: Model<CrmSettingSchemaDocument>,
  ) {}

  async findOne(tenantId: string, key: string): Promise<CrmSetting | null> {
    const doc = await this.model.findOne({ tenantId, key }).exec();
    return doc ? CrmSettingMapper.toDomain(doc) : null;
  }

  async update(tenantId: string, key: string, value: any): Promise<CrmSetting> {
    const doc = await this.model
      .findOneAndUpdate(
        { tenantId, key },
        { value },
        { upsert: true, new: true },
      )
      .exec();
    return CrmSettingMapper.toDomain(doc);
  }

  async pushLifecycleStage(
    tenantId: string,
    key: string,
    stage: Record<string, any>,
  ): Promise<CrmSetting | null> {
    const doc = await this.model
      .findOneAndUpdate(
        {
          tenantId,
          key,
          'value.stages.apiName': { $ne: stage.apiName },
        },
        { $push: { 'value.stages': stage } },
        { new: true },
      )
      .exec();

    return doc ? CrmSettingMapper.toDomain(doc) : null;
  }

  async updateLifecycleStage(
    tenantId: string,
    key: string,
    stageId: string,
    updates: Record<string, any>,
  ): Promise<CrmSetting | null> {
    const set: Record<string, any> = {};
    for (const [field, value] of Object.entries(updates)) {
      if (value !== undefined) {
        set[`value.stages.$.${field}`] = value;
      }
    }

    const doc = await this.model
      .findOneAndUpdate(
        {
          tenantId,
          key,
          'value.stages.id': stageId,
        },
        { $set: set },
        { new: true },
      )
      .exec();

    return doc ? CrmSettingMapper.toDomain(doc) : null;
  }

  async pullLifecycleStage(
    tenantId: string,
    key: string,
    stageId: string,
  ): Promise<CrmSetting | null> {
    const doc = await this.model
      .findOneAndUpdate(
        {
          tenantId,
          key,
          'value.stages.id': stageId,
        },
        { $pull: { 'value.stages': { id: stageId } } },
        { new: true },
      )
      .exec();

    return doc ? CrmSettingMapper.toDomain(doc) : null;
  }

  async pushLifecycleStatus(
    tenantId: string,
    key: string,
    stageId: string,
    status: Record<string, any>,
  ): Promise<CrmSetting | null> {
    const doc = await this.model
      .findOneAndUpdate(
        {
          tenantId,
          key,
          'value.stages': {
            $elemMatch: {
              id: stageId,
              statuses: {
                $not: {
                  $elemMatch: { apiName: status.apiName },
                },
              },
            },
          },
        },
        { $push: { 'value.stages.$[stage].statuses': status } },
        {
          new: true,
          arrayFilters: [{ 'stage.id': stageId }],
        },
      )
      .exec();

    return doc ? CrmSettingMapper.toDomain(doc) : null;
  }

  async updateLifecycleStatus(
    tenantId: string,
    key: string,
    stageId: string,
    statusId: string,
    updates: Record<string, any>,
  ): Promise<CrmSetting | null> {
    const set: Record<string, any> = {};
    for (const [field, value] of Object.entries(updates)) {
      if (value !== undefined) {
        set[`value.stages.$[stage].statuses.$[status].${field}`] = value;
      }
    }

    const stageMatch: Record<string, any> = {
      id: stageId,
      statuses: { $elemMatch: { id: statusId } },
    };

    if (updates.apiName !== undefined) {
      stageMatch.$and = [
        { statuses: { $elemMatch: { id: statusId } } },
        {
          statuses: {
            $not: {
              $elemMatch: { apiName: updates.apiName, id: { $ne: statusId } },
            },
          },
        },
      ];
      delete stageMatch.statuses;
    }

    const doc = await this.model
      .findOneAndUpdate(
        {
          tenantId,
          key,
          'value.stages': { $elemMatch: stageMatch },
        },
        { $set: set },
        {
          new: true,
          arrayFilters: [{ 'stage.id': stageId }, { 'status.id': statusId }],
        },
      )
      .exec();

    return doc ? CrmSettingMapper.toDomain(doc) : null;
  }

  async clearLifecycleStatusDefaults(
    tenantId: string,
    key: string,
    stageId: string,
  ): Promise<void> {
    await this.model
      .findOneAndUpdate(
        {
          tenantId,
          key,
          'value.stages.id': stageId,
        },
        { $set: { 'value.stages.$.statuses.$[].isDefault': false } },
      )
      .exec();
  }

  async pullLifecycleStatus(
    tenantId: string,
    key: string,
    stageId: string,
    statusId: string,
  ): Promise<CrmSetting | null> {
    const doc = await this.model
      .findOneAndUpdate(
        {
          tenantId,
          key,
          'value.stages.id': stageId,
        },
        { $pull: { 'value.stages.$.statuses': { id: statusId } } },
        { new: true },
      )
      .exec();

    return doc ? CrmSettingMapper.toDomain(doc) : null;
  }

  // ── List Views (atomic array ops on value.views) ─────────────────────────

  /**
   * Atomically append a view. Upserts the setting document and guards against
   * a duplicate (module, name) pair in a single round-trip.
   * Returns null when a same-module/name view already exists (lost the race).
   */
  async pushListView(
    tenantId: string,
    key: string,
    view: Record<string, any>,
  ): Promise<CrmSetting | null> {
    // Ensure the document and the views array exist first (no-op if present).
    await this.model
      .findOneAndUpdate(
        { tenantId, key, 'value.views': { $exists: false } },
        { $set: { 'value.views': [] } },
        { upsert: true },
      )
      .exec();

    const doc = await this.model
      .findOneAndUpdate(
        {
          tenantId,
          key,
          'value.views': {
            $not: {
              $elemMatch: { module: view.module, name: view.name },
            },
          },
        },
        { $push: { 'value.views': view } },
        { new: true },
      )
      .exec();

    return doc ? CrmSettingMapper.toDomain(doc) : null;
  }

  /**
   * Atomically apply field updates to a single view matched by id.
   * Returns null when no matching view exists.
   */
  async updateListView(
    tenantId: string,
    key: string,
    viewId: string,
    updates: Record<string, any>,
  ): Promise<CrmSetting | null> {
    const set: Record<string, any> = {};
    for (const [field, value] of Object.entries(updates)) {
      if (value !== undefined) {
        set[`value.views.$.${field}`] = value;
      }
    }

    if (Object.keys(set).length === 0) {
      const doc = await this.model.findOne({ tenantId, key }).exec();
      return doc ? CrmSettingMapper.toDomain(doc) : null;
    }

    const doc = await this.model
      .findOneAndUpdate(
        { tenantId, key, 'value.views.id': viewId },
        { $set: set },
        { new: true },
      )
      .exec();

    return doc ? CrmSettingMapper.toDomain(doc) : null;
  }

  /**
   * Atomically remove a view by id. Returns null when no matching view exists.
   */
  async pullListView(
    tenantId: string,
    key: string,
    viewId: string,
  ): Promise<CrmSetting | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { tenantId, key, 'value.views.id': viewId },
        { $pull: { 'value.views': { id: viewId } } },
        { new: true },
      )
      .exec();

    return doc ? CrmSettingMapper.toDomain(doc) : null;
  }

  /**
   * Atomically append several default views for modules that are missing.
   * Used by the list-views auto-migration on the WRITE path only.
   */
  async pushManyListViews(
    tenantId: string,
    key: string,
    views: Record<string, any>[],
  ): Promise<CrmSetting | null> {
    if (views.length === 0) {
      const doc = await this.model.findOne({ tenantId, key }).exec();
      return doc ? CrmSettingMapper.toDomain(doc) : null;
    }

    await this.model
      .findOneAndUpdate(
        { tenantId, key, 'value.views': { $exists: false } },
        { $set: { 'value.views': [] } },
        { upsert: true },
      )
      .exec();

    const doc = await this.model
      .findOneAndUpdate(
        { tenantId, key },
        { $push: { 'value.views': { $each: views } } },
        { new: true },
      )
      .exec();

    return doc ? CrmSettingMapper.toDomain(doc) : null;
  }
}
