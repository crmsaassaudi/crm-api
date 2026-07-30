import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { CreateInboxDto, UpdateInboxDto } from './dto/inbox.dto';
import { InboxDocument, InboxSchemaClass } from './infrastructure/inbox.schema';
import {
  ChannelSchemaClass,
  ChannelSchemaDocument,
} from '../channels/infrastructure/persistence/document/entities/channel.schema';

@Injectable()
export class InboxesService {
  constructor(
    @InjectModel(InboxSchemaClass.name)
    private readonly inboxes: Model<InboxDocument>,
    @InjectModel(ChannelSchemaClass.name)
    private readonly channels: Model<ChannelSchemaDocument>,
    private readonly cls: ClsService,
  ) {}

  async list(includeArchived = false): Promise<any[]> {
    return await this.inboxes
      .find({
        tenantId: this.tenantId(),
        ...(includeArchived ? {} : { status: 'active' }),
      })
      .sort({ name: 1, _id: 1 })
      .lean()
      .exec();
  }

  async get(id: string): Promise<any> {
    const inbox = await this.inboxes
      .findOne({ _id: id, tenantId: this.tenantId() })
      .lean()
      .exec();
    if (!inbox) throw new NotFoundException('Inbox not found');
    return inbox;
  }

  async create(dto: CreateInboxDto): Promise<any> {
    try {
      return await this.inboxes.create({
        ...dto,
        key: dto.key.toLowerCase(),
        tenantId: this.tenantId(),
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        throw new ConflictException(`Inbox key '${dto.key}' already exists`);
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateInboxDto): Promise<any> {
    const inbox = await this.inboxes
      .findOneAndUpdate(
        { _id: id, tenantId: this.tenantId() },
        { $set: dto },
        { new: true, runValidators: true },
      )
      .lean()
      .exec();
    if (!inbox) throw new NotFoundException('Inbox not found');
    return inbox;
  }

  async attachChannel(
    inboxId: string,
    channelId: string,
  ): Promise<{ inboxId: string; channelId: string }> {
    const tenantId = this.tenantId();
    const inbox = await this.inboxes
      .findOne({ _id: inboxId, tenantId, status: 'active' })
      .select('_id')
      .lean()
      .exec();
    if (!inbox) throw new NotFoundException('Active inbox not found');

    const channel = await this.channels
      .findOneAndUpdate(
        { _id: channelId, tenantId },
        { $set: { inboxId } },
        { new: true },
      )
      .lean()
      .exec();
    if (!channel) throw new NotFoundException('Channel not found');
    return { inboxId, channelId };
  }

  private tenantId(): string {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) throw new Error('Tenant context is required');
    return tenantId;
  }
}
