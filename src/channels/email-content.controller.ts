import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { ClsService } from 'nestjs-cls';
import { EmailContentDocument } from './infrastructure/persistence/document/entities/email-content.schema';
import { EmailMetadataDocument } from './infrastructure/persistence/document/entities/email-metadata.schema';

/**
 * EmailContentController — Serves full email content & metadata to the frontend.
 *
 * Security:
 *   - BCC Privacy (Appendix E): The `bcc` field is NEVER returned unless
 *     the requesting user is the sender OR has admin role. This enforcement
 *     happens at the backend serialization layer — not the frontend —
 *     ensuring BCC data is invisible even under network inspection.
 */
@ApiTags('Channels - Email Content')
@ApiBearerAuth()
@Controller({ path: 'channels/email-contents', version: '1' })
export class EmailContentController {
  constructor(
    @InjectModel('EmailContentSchemaClass')
    private readonly emailContentModel: Model<EmailContentDocument>,
    @InjectModel('EmailMetadataSchemaClass')
    private readonly emailMetadataModel: Model<EmailMetadataDocument>,
    private readonly clsService: ClsService,
  ) {}

  @Get(':messageId')
  @ApiOperation({
    summary: 'Get full HTML content and metadata for an email message',
  })
  async getEmailContent(@Param('messageId') messageId: string) {
    const tenantId = this.clsService.get('tenantId');
    const userId = this.clsService.get('userId');
    const userRole = this.clsService.get('userRole') || '';

    // Multi-strategy lookup: the frontend may pass either:
    // 1. The omni_messages._id (from message.id in the store)
    // 2. The email_contents._id (from metadata.emailContentId)
    // 3. The generatedMessageId stored in email_contents.messageId
    let content = await this.emailContentModel.findOne({
      tenantId,
      messageId,
    });

    if (!content) {
      // Fallback: try by document _id
      content = await this.emailContentModel
        .findOne({
          tenantId,
          _id: messageId,
        })
        .catch(() => null);
    }

    if (!content) {
      throw new NotFoundException(
        `Email content not found for message ${messageId}`,
      );
    }

    // Use the same messageId from the found content for metadata lookup
    const contentMessageId = content.messageId;
    let metadata = await this.emailMetadataModel.findOne({
      tenantId,
      messageId: contentMessageId,
    });

    if (!metadata) {
      // Fallback: try with the original param
      metadata = await this.emailMetadataModel
        .findOne({
          tenantId,
          messageId,
        })
        .catch(() => null);
    }

    // ── BCC Privacy (Role-Based Serialization) ──────────────────────────
    // Appendix E: bcc is ONLY visible to the sender or admin.
    // This prevents agents from seeing BCC recipients of emails sent by
    // other agents, even if they have access to the conversation.
    const senderId = (metadata as any)?.senderId?.toString();
    const isAdmin = userRole === 'admin' || userRole === 'owner';
    const isSender = senderId && senderId === userId;
    const visibleBcc = isAdmin || isSender ? metadata?.bcc || [] : [];

    // ── Source Deleted Badge ──────────────────────────────────────────────
    // Immutable Records Policy: show badge if email was deleted on provider
    const sourceDeleted = (content as any).sourceDeleted || false;

    return {
      messageId: content.messageId,
      subject: content.subject,
      htmlBody: content.htmlBody,
      textBody: content.textBody,
      attachments: content.attachments || [],
      from: metadata?.from || '',
      to: metadata?.to || [],
      cc: metadata?.cc || [],
      bcc: visibleBcc,
      inReplyTo: metadata?.inReplyTo || null,
      references: metadata?.references || [],
      sourceDeleted,
    };
  }
}
