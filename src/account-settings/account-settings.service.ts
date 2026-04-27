import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import {
  AccountStatusSchemaClass,
  AccountStatusDocument,
} from './entities/account-status.schema';
import {
  AccountTypeSchemaClass,
  AccountTypeDocument,
} from './entities/account-type.schema';

@Injectable()
export class AccountSettingsService {
  constructor(
    @InjectModel(AccountStatusSchemaClass.name)
    private readonly statusModel: Model<AccountStatusDocument>,
    @InjectModel(AccountTypeSchemaClass.name)
    private readonly typeModel: Model<AccountTypeDocument>,
    private readonly cls: ClsService,
  ) {}

  private get tenantId(): string {
    return this.cls.get('tenantId');
  }

  // ── Statuses ───────────────────────────────────────────────────────────
  async findAllStatuses() {
    return this.statusModel
      .find({ tenantId: this.tenantId })
      .sort({ sortOrder: 1 })
      .exec();
  }

  async createStatus(data: Partial<AccountStatusSchemaClass>) {
    return this.statusModel.create({ ...data, tenantId: this.tenantId });
  }

  async updateStatus(id: string, data: Partial<AccountStatusSchemaClass>) {
    return this.statusModel
      .findOneAndUpdate({ _id: id, tenantId: this.tenantId }, data, {
        new: true,
      })
      .exec();
  }

  async deleteStatus(id: string): Promise<void> {
    await this.statusModel
      .deleteOne({ _id: id, tenantId: this.tenantId })
      .exec();
  }

  // ── Types ──────────────────────────────────────────────────────────────
  async findAllTypes() {
    return this.typeModel
      .find({ tenantId: this.tenantId })
      .sort({ sortOrder: 1 })
      .exec();
  }

  async createType(data: Partial<AccountTypeSchemaClass>) {
    return this.typeModel.create({ ...data, tenantId: this.tenantId });
  }

  async updateType(id: string, data: Partial<AccountTypeSchemaClass>) {
    return this.typeModel
      .findOneAndUpdate({ _id: id, tenantId: this.tenantId }, data, {
        new: true,
      })
      .exec();
  }

  async deleteType(id: string): Promise<void> {
    await this.typeModel.deleteOne({ _id: id, tenantId: this.tenantId }).exec();
  }
}
