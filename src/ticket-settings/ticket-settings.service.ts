import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import {
  TicketStatusSchemaClass,
  TicketStatusDocument,
} from './entities/ticket-status.schema';
import {
  TicketTypeSchemaClass,
  TicketTypeDocument,
} from './entities/ticket-type.schema';
import {
  TicketSourceSchemaClass,
  TicketSourceDocument,
} from './entities/ticket-source.schema';
import {
  TicketResolutionCodeSchemaClass,
  TicketResolutionCodeDocument,
} from './entities/ticket-resolution-code.schema';

@Injectable()
export class TicketSettingsService {
  constructor(
    @InjectModel(TicketStatusSchemaClass.name)
    private readonly statusModel: Model<TicketStatusDocument>,
    @InjectModel(TicketTypeSchemaClass.name)
    private readonly typeModel: Model<TicketTypeDocument>,
    @InjectModel(TicketSourceSchemaClass.name)
    private readonly sourceModel: Model<TicketSourceDocument>,
    @InjectModel(TicketResolutionCodeSchemaClass.name)
    private readonly resolutionCodeModel: Model<TicketResolutionCodeDocument>,
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

  async createStatus(data: Partial<TicketStatusSchemaClass>) {
    return this.statusModel.create({ ...data, tenantId: this.tenantId });
  }

  async updateStatus(id: string, data: Partial<TicketStatusSchemaClass>) {
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

  async findStatusById(id: string) {
    return this.statusModel
      .findOne({ _id: id, tenantId: this.tenantId })
      .exec();
  }

  async findTerminalStatusIds(): Promise<string[]> {
    const docs = await this.statusModel
      .find({ tenantId: this.tenantId, isTerminal: true })
      .select('_id')
      .exec();
    return docs.map((d) => d._id.toString());
  }

  // ── Types ──────────────────────────────────────────────────────────────
  async findAllTypes() {
    return this.typeModel
      .find({ tenantId: this.tenantId })
      .sort({ sortOrder: 1 })
      .exec();
  }

  async createType(data: Partial<TicketTypeSchemaClass>) {
    return this.typeModel.create({ ...data, tenantId: this.tenantId });
  }

  async updateType(id: string, data: Partial<TicketTypeSchemaClass>) {
    return this.typeModel
      .findOneAndUpdate({ _id: id, tenantId: this.tenantId }, data, {
        new: true,
      })
      .exec();
  }

  async deleteType(id: string): Promise<void> {
    await this.typeModel.deleteOne({ _id: id, tenantId: this.tenantId }).exec();
  }

  // ── Sources ────────────────────────────────────────────────────────────
  async findAllSources() {
    return this.sourceModel
      .find({ tenantId: this.tenantId })
      .sort({ sortOrder: 1 })
      .exec();
  }

  async createSource(data: Partial<TicketSourceSchemaClass>) {
    return this.sourceModel.create({ ...data, tenantId: this.tenantId });
  }

  async updateSource(id: string, data: Partial<TicketSourceSchemaClass>) {
    return this.sourceModel
      .findOneAndUpdate({ _id: id, tenantId: this.tenantId }, data, {
        new: true,
      })
      .exec();
  }

  async deleteSource(id: string): Promise<void> {
    await this.sourceModel
      .deleteOne({ _id: id, tenantId: this.tenantId })
      .exec();
  }

  // ── Resolution Codes ──────────────────────────────────────────────────
  async findAllResolutionCodes() {
    return this.resolutionCodeModel
      .find({ tenantId: this.tenantId })
      .sort({ name: 1 })
      .exec();
  }

  async createResolutionCode(data: Partial<TicketResolutionCodeSchemaClass>) {
    return this.resolutionCodeModel.create({
      ...data,
      tenantId: this.tenantId,
    });
  }

  async updateResolutionCode(
    id: string,
    data: Partial<TicketResolutionCodeSchemaClass>,
  ) {
    return this.resolutionCodeModel
      .findOneAndUpdate({ _id: id, tenantId: this.tenantId }, data, {
        new: true,
      })
      .exec();
  }

  async deleteResolutionCode(id: string): Promise<void> {
    await this.resolutionCodeModel
      .deleteOne({ _id: id, tenantId: this.tenantId })
      .exec();
  }
}
