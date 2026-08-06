import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import {
  TicketSchemaClass,
  TicketSchemaDocument,
} from '../tickets/infrastructure/persistence/document/entities/ticket.schema';
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
    @InjectModel(TicketSchemaClass.name)
    private readonly ticketModel: Model<TicketSchemaDocument>,
    private readonly cls: ClsService,
  ) {}

  private get tenantId(): string {
    return this.cls.get('tenantId');
  }

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
    await this.assertUnreferenced('statusId', id, 'status');
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
    await this.assertUnreferenced('typeId', id, 'type');
    await this.typeModel.deleteOne({ _id: id, tenantId: this.tenantId }).exec();
  }

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
    await this.assertUnreferenced('sourceId', id, 'source');
    await this.sourceModel
      .deleteOne({ _id: id, tenantId: this.tenantId })
      .exec();
  }

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
    await this.assertUnreferenced('resolutionCodeId', id, 'resolution code');
    await this.resolutionCodeModel
      .deleteOne({ _id: id, tenantId: this.tenantId })
      .exec();
  }

  /**
   * Refuse to delete a catalog entry that live tickets still point at.
   *
   * Deleting one used to succeed unconditionally, leaving every ticket that
   * referenced it holding a dangling id: the detail page renders "-", the list
   * filter cannot match it, and the report `$lookup` drops the row entirely.
   * Nothing errored, so the tickets simply stopped being counted.
   *
   * Counted with a cap: the answer only needs to be "any", and a tenant with
   * 400k tickets on one status should not pay for an exact count to be told no.
   */
  private async assertUnreferenced(
    field: 'statusId' | 'typeId' | 'sourceId' | 'resolutionCodeId',
    id: string,
    label: string,
  ): Promise<void> {
    const inUse = await this.ticketModel
      .countDocuments({
        tenantId: this.tenantId,
        [field]: id,
        deletedAt: null,
      })
      .limit(1)
      .exec();
    if (inUse > 0) {
      throw new ConflictException(
        `This ${label} is still used by at least one ticket. Move those tickets first, or keep the ${label} and hide it from new tickets.`,
      );
    }
  }
}
