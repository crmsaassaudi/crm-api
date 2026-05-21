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
}
