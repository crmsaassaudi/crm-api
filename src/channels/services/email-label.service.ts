import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ChannelConfigRepository } from '../infrastructure/persistence/document/repositories/channel-config.repository';
import { EmailMetadataSchemaClass } from '../infrastructure/persistence/document/entities/email-metadata.schema';
import {
  EmailProviderLabelDocument,
  EmailProviderLabelSchemaClass,
} from '../infrastructure/persistence/document/entities/email-provider-label.schema';
import { CRYPTO_SERVICE_TOKEN, ICryptoService } from '../domain/crypto.service';

type ObservedLabel = {
  id: string;
  name: string;
  type?: 'system' | 'user';
  color?: string | null;
};

@Injectable()
export class EmailLabelService {
  private readonly logger = new Logger(EmailLabelService.name);
  private readonly systemLabels = new Set([
    'INBOX',
    'SENT',
    'DRAFTS',
    'TRASH',
    'SPAM',
    'ARCHIVE',
    'UNREAD',
    'STARRED',
    'IMPORTANT',
  ]);
  private readonly colorTokens = [
    'slate',
    'blue',
    'emerald',
    'amber',
    'rose',
    'violet',
    'cyan',
    'lime',
  ];

  constructor(
    private readonly cls: ClsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configRepo: ChannelConfigRepository,
    @Inject(CRYPTO_SERVICE_TOKEN)
    private readonly crypto: ICryptoService,
    @InjectModel(EmailProviderLabelSchemaClass.name)
    private readonly labelModel: Model<EmailProviderLabelDocument>,
    @InjectModel(EmailMetadataSchemaClass.name)
    private readonly metadataModel: Model<EmailMetadataSchemaClass>,
  ) {}

  async listLabels(
    mailboxId: string,
    options: {
      search?: string;
      page?: number;
      limit?: number;
      includeDeleted?: boolean;
      refreshProvider?: boolean;
    },
  ) {
    const tenantId = this.cls.get('tenantId');
    await this.ensureMailbox(tenantId, mailboxId);

    if (options.refreshProvider) {
      await this.reconcile(mailboxId);
    }

    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 50));
    const filter: Record<string, any> = {
      tenantId,
      mailboxId,
    };

    if (!options.includeDeleted) filter.isDeleted = false;
    if (options.search?.trim()) {
      filter.name = {
        $regex: this.escapeRegex(options.search.trim()),
        $options: 'i',
      };
    }

    const [items, total] = await Promise.all([
      this.labelModel
        .find(filter)
        .sort({ type: 1, name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.labelModel.countDocuments(filter),
    ]);

    return {
      items: items.map((label) => ({
        id: label._id?.toString(),
        mailboxId: label.mailboxId?.toString(),
        provider: label.provider,
        providerLabelId: label.providerLabelId,
        name: label.name,
        type: label.type,
        color: label.color,
        normalizedColor: label.normalizedColor,
        isDeleted: label.isDeleted,
        lastSeenAt: label.lastSeenAt,
        usageCount: label.usageCount,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  async reconcile(mailboxId: string) {
    const tenantId = this.cls.get('tenantId');
    const mailbox = await this.ensureMailbox(tenantId, mailboxId);
    const now = new Date();
    const observed = new Map<string, ObservedLabel & { usageCount: number }>();
    const providerLabels = await this.fetchProviderLabels(tenantId, mailboxId);

    for (const label of providerLabels) {
      observed.set(label.id, {
        ...label,
        usageCount: 0,
      });
    }

    const rows = await this.metadataModel
      .find({
        tenantId,
        mailboxId,
        providerLabelIds: { $exists: true, $ne: [] },
      })
      .select('providerLabelIds providerLabels providerLabelDetails')
      .lean()
      .exec();

    for (const row of rows as any[]) {
      const ids: string[] = row.providerLabelIds || [];
      const names: string[] = row.providerLabels || [];
      const details: ObservedLabel[] = row.providerLabelDetails || [];

      ids.forEach((id, index) => {
        if (!id) return;
        const detail = details.find((item) => item.id === id);
        const label = observed.get(id) || {
          id,
          name: detail?.name || names[index] || id,
          type: detail?.type || this.detectLabelType(id),
          color: detail?.color || null,
          usageCount: 0,
        };
        label.usageCount += 1;
        observed.set(id, label);
      });
    }

    for (const label of observed.values()) {
      await this.upsertLabel({
        tenantId,
        mailboxId,
        provider: mailbox.providerType,
        providerLabelId: label.id,
        name: label.name,
        type: label.type || this.detectLabelType(label.id),
        color: label.color || null,
        normalizedColor: this.normalizeColor(
          label.color,
          label.name || label.id,
        ),
        lastSeenAt: now,
        usageCount: label.usageCount,
        usageCountMode: 'set',
      });
    }

    const observedIds = [...observed.keys()];
    await this.labelModel
      .updateMany(
        {
          tenantId,
          mailboxId,
          provider: mailbox.providerType,
          ...(observedIds.length
            ? { providerLabelId: { $nin: observedIds } }
            : {}),
        },
        { $set: { isDeleted: true } },
      )
      .exec();

    const result = {
      mailboxId,
      provider: mailbox.providerType,
      synced: observed.size,
      providerLabels: providerLabels.length,
      scannedMessages: rows.length,
      reconciledAt: now,
    };

    this.eventEmitter.emit('channel-config.audit.label-reconcile', {
      tenantId,
      userId: this.cls.get('userId') || 'system',
      configId: mailboxId,
      configName: mailbox.name,
      providerType: mailbox.providerType,
      ipAddress: this.cls.get('clientIp') || null,
      userAgent: this.cls.get('userAgent') || null,
      changes: result,
    });

    return result;
  }

  @OnEvent('email.labels.observed')
  async handleObservedLabels(payload: {
    tenantId: string;
    mailboxId: string;
    provider: string;
    labels: ObservedLabel[];
  }): Promise<void> {
    if (!payload.tenantId || !payload.mailboxId || !payload.provider) return;
    const now = new Date();

    try {
      for (const label of payload.labels || []) {
        await this.upsertLabel({
          tenantId: payload.tenantId,
          mailboxId: payload.mailboxId,
          provider: payload.provider,
          providerLabelId: label.id,
          name: label.name || label.id,
          type: label.type || this.detectLabelType(label.id),
          color: label.color || null,
          normalizedColor: this.normalizeColor(
            label.color,
            label.name || label.id,
          ),
          lastSeenAt: now,
          usageCount: 1,
          usageCountMode: 'inc',
        });
      }
    } catch (error: any) {
      this.logger.warn(
        `[EmailLabel] Passive capture failed for mailbox ${payload.mailboxId}: ${error.message}`,
      );
    }
  }

  buildLabelDetails(
    providerLabelIds: string[],
    providerLabels: string[],
  ): ObservedLabel[] {
    return providerLabelIds.map((id, index) => ({
      id,
      name: providerLabels[index] || id,
      type: this.detectLabelType(id),
      color: null,
    }));
  }

  private async ensureMailbox(tenantId: string, mailboxId: string) {
    if (!tenantId) throw new BadRequestException('Missing tenant context');
    const mailbox = await this.configRepo.findById(tenantId, mailboxId);
    if (!mailbox) throw new NotFoundException('Mailbox not found');
    if (mailbox.providerType !== 'smtp') {
      throw new BadRequestException(
        'Mailbox labels are currently supported for email configs only',
      );
    }
    return mailbox;
  }

  private async upsertLabel(data: {
    tenantId: string;
    mailboxId: string;
    provider: string;
    providerLabelId: string;
    name: string;
    type: 'system' | 'user';
    color: string | null;
    normalizedColor: string;
    lastSeenAt: Date;
    usageCount: number;
    usageCountMode?: 'set' | 'inc';
  }): Promise<void> {
    const setFields: Record<string, any> = {
      name: data.name,
      type: data.type,
      color: data.color,
      normalizedColor: data.normalizedColor,
      isDeleted: false,
      lastSeenAt: data.lastSeenAt,
    };
    const update: Record<string, any> = { $set: setFields };
    if (data.usageCountMode === 'inc') {
      update.$inc = { usageCount: data.usageCount };
    } else {
      setFields.usageCount = data.usageCount;
    }

    await this.labelModel
      .findOneAndUpdate(
        {
          tenantId: data.tenantId,
          mailboxId: data.mailboxId,
          provider: data.provider,
          providerLabelId: data.providerLabelId,
        },
        update,
        { upsert: true, new: true },
      )
      .exec();
  }

  private async fetchProviderLabels(
    tenantId: string,
    mailboxId: string,
  ): Promise<ObservedLabel[]> {
    const config = await this.configRepo.findByIdWithCredentials(
      tenantId,
      mailboxId,
    );
    if (!config?.encryptedCredentials || !config.publicSettings?.imapHost) {
      throw new BadRequestException(
        'IMAP is not configured for this mailbox, so provider labels cannot be discovered.',
      );
    }

    let ImapFlow: any;
    try {
      ImapFlow = (await import('imapflow')).ImapFlow;
    } catch {
      throw new BadRequestException('imapflow package is not available.');
    }

    let credentials: Record<string, any>;
    try {
      credentials = JSON.parse(
        await this.crypto.decrypt(config.encryptedCredentials),
      );
    } catch (error: any) {
      throw new BadRequestException(
        `Could not decrypt mailbox credentials: ${error.message}`,
      );
    }

    const imapPort = Number(config.publicSettings?.imapPort || 993);
    const client = new ImapFlow({
      host: config.publicSettings.imapHost,
      port: imapPort,
      secure: imapPort === 993,
      auth: {
        user: credentials.user,
        pass: credentials.password,
      },
      logger: false,
    });

    try {
      await client.connect();
      const mailboxes = await client.list();
      return mailboxes
        .map((mailbox: any) => this.mailboxToLabel(mailbox))
        .filter((label): label is ObservedLabel => Boolean(label));
    } catch (error: any) {
      throw new BadRequestException(
        `Provider label discovery failed: ${error.message}. For Gmail, make sure each label has "Show in IMAP" enabled in Gmail settings.`,
      );
    } finally {
      await client.logout().catch(() => {});
    }
  }

  private mailboxToLabel(mailbox: any): ObservedLabel | null {
    const path = String(mailbox.path || mailbox.pathAsListed || '').trim();
    if (!path) return null;

    const flags = mailbox.flags instanceof Set ? mailbox.flags : new Set();
    if (flags.has('\\Noselect') && path === '[Gmail]') return null;

    if (path.startsWith('[Gmail]/')) {
      const system = this.normalizeSystemMailbox(path);
      return system
        ? {
            id: system.id,
            name: system.name,
            type: 'system',
            color: null,
          }
        : null;
    }

    const system = this.normalizeSystemMailbox(path);
    if (system) {
      return {
        id: system.id,
        name: system.name,
        type: 'system',
        color: null,
      };
    }

    return {
      id: path,
      name: path,
      type: 'user',
      color: null,
    };
  }

  private normalizeSystemMailbox(
    path: string,
  ): { id: string; name: string } | null {
    const upper = path.toUpperCase();
    if (upper === 'INBOX') return { id: 'INBOX', name: 'Inbox' };
    if (upper.includes('SENT')) return { id: 'SENT', name: 'Sent' };
    if (upper.includes('DRAFT')) return { id: 'DRAFTS', name: 'Drafts' };
    if (upper.includes('TRASH') || upper.includes('BIN')) {
      return { id: 'TRASH', name: 'Trash' };
    }
    if (upper.includes('SPAM') || upper.includes('JUNK')) {
      return { id: 'SPAM', name: 'Spam' };
    }
    if (upper.includes('ALL MAIL')) return { id: 'ARCHIVE', name: 'Archive' };
    return null;
  }

  private detectLabelType(labelId: string): 'system' | 'user' {
    return this.systemLabels.has(labelId.toUpperCase()) ? 'system' : 'user';
  }

  private normalizeColor(
    color: string | null | undefined,
    seed: string,
  ): string {
    if (color) {
      const lower = color.toLowerCase();
      if (lower.includes('red') || lower.includes('rose')) return 'rose';
      if (lower.includes('green') || lower.includes('emerald'))
        return 'emerald';
      if (lower.includes('yellow') || lower.includes('orange')) return 'amber';
      if (lower.includes('purple') || lower.includes('violet')) return 'violet';
      if (lower.includes('cyan') || lower.includes('teal')) return 'cyan';
      if (lower.includes('blue')) return 'blue';
    }

    let hash = 0;
    for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return this.colorTokens[hash % this.colorTokens.length];
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
