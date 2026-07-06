import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * EmailNormalizerService — The critical gateway filter for inbound emails.
 *
 * Responsibilities (in order):
 *   1. Auto-Responder Detection  → Drop "Out of Office" / loop emails
 *   2. Bounce Detection          → Extract failure reason, emit status update
 *   3. Thread Correlation        → Hybrid 3-Layer Strategy (Headers → Fence → Fuzzy)
 *   4. Lazy Reply Guard          → Soft-Link stale threads (configurable SLA)
 *   5. CID Image Pipeline        → Size-threshold filter (< 10KB → Base64, ≥ 10KB → S3)
 *   6. Content Separation        → HTML→email_contents, Attachments→FileService
 *   7. Lightweight Payload       → Generate small OmniPayload for Queue
 *
 * Architecture Decisions (Devil's Advocate Rules embedded):
 *   - GDPR Multi-party: contactIds[] populated from all participants
 *   - Soft-Link: Over-age threads create new conversation with parentConversationId FK
 *   - Hidden Watermark REJECTED: Using Signature Fence instead (deliverability safe)
 *   - CID Size Filter: < 10KB inline images stay Base64 to prevent S3 bloat
 */

/** Result of thread correlation — which conversation does this email belong to? */
export interface ThreadCorrelationResult {
  /** Which layer resolved the correlation */
  resolvedBy: 'header' | 'fence' | 'fuzzy' | 'new';
  /** Internal CRM conversation ID (null if new conversation) */
  conversationId: string | null;
  /** Confidence level for fuzzy matches */
  confidence?: number;
}

/** Result of soft-link thread break evaluation */
export interface SoftLinkResult {
  /** 'continue' = append to existing thread, 'soft_link' = create new with parent FK */
  action: 'continue' | 'soft_link';
  /** Original conversation ID (only when action === 'soft_link') */
  parentConversationId?: string;
}

/** CID inline image extracted from MIME body */
export interface CidAttachment {
  /** CID reference (e.g., "image001") */
  cid: string;
  /** Image binary data */
  buffer: Buffer;
  /** MIME content type (e.g., "image/png") */
  contentType: string;
  /** Size in bytes */
  sizeBytes: number;
}

@Injectable()
export class EmailNormalizerService {
  private readonly logger = new Logger(EmailNormalizerService.name);

  constructor(private readonly eventEmitter: EventEmitter2) {}

  // ── 1. Auto-Responder Detection ─────────────────────────────────────────

  /**
   * Check if an email is an auto-reply/auto-responder that should be dropped.
   * Scans standard headers used by major email providers.
   *
   * Returns true if the email should be DROPPED (not processed).
   */
  isAutoResponder(
    headers: Record<string, string | string[]>,
    blockAutoResponders: boolean = false,
  ): boolean {
    if (!blockAutoResponders) {
      return false;
    }

    // RFC 3834: Auto-Submitted header
    // We only want to drop 'auto-replied' (Out-of-Office).
    // 'auto-generated' (GitHub, Jira, etc.) should be ALLOWED.
    const autoSubmitted = (
      this.getHeader(headers, 'auto-submitted') ?? ''
    ).toLowerCase();
    if (autoSubmitted === 'auto-replied') {
      this.logger.debug(
        `[EmailNormalizer] Dropping Out-of-Office/Auto-reply: Auto-Submitted=${autoSubmitted}`,
      );
      return true;
    }

    // Microsoft/Exchange: X-Auto-Response-Suppress
    // Only drop if it specifically suppresses all or OOF
    const autoResponse = (
      this.getHeader(headers, 'x-auto-response-suppress') ?? ''
    ).toLowerCase();
    if (
      autoResponse &&
      (autoResponse.includes('all') || autoResponse.includes('oof'))
    ) {
      this.logger.debug(
        `[EmailNormalizer] Dropping MS-Exchange OOF: ${autoResponse}`,
      );
      return true;
    }

    // X-Autoreply / X-Autorespond (common in older systems)
    if (
      this.getHeader(headers, 'x-autoreply') ||
      this.getHeader(headers, 'x-autorespond')
    ) {
      return true;
    }

    // Precedence: bulk, junk, list
    // We NO LONGER drop 'bulk' or 'list' because many important system notifications
    // (like GitHub launch codes, password resets) use these headers.
    const precedence = (
      this.getHeader(headers, 'precedence') ?? ''
    ).toLowerCase();
    if (precedence === 'junk') {
      return true;
    }

    return false;
  }

  // ── 2. Bounce Detection ────────────────────────────────────────────────

  /**
   * Check if an email is a Delivery Status Notification (bounce).
   * Returns bounce info if detected, null otherwise.
   */
  detectBounce(
    headers: Record<string, string | string[]>,
    textBody: string,
  ): {
    isBounce: boolean;
    originalMessageId: string | null;
    reason: string;
  } | null {
    const contentType = this.getHeader(headers, 'content-type') ?? '';

    // Standard DSN content type
    const isDSN =
      contentType.includes('multipart/report') &&
      contentType.includes('delivery-status');

    // From Mailer-Daemon
    const from = (this.getHeader(headers, 'from') ?? '').toLowerCase();
    const isMailerDaemon =
      from.includes('mailer-daemon') ||
      from.includes('postmaster') ||
      from.includes('mail delivery');

    // Return-Path empty = system mail
    const returnPath = this.getHeader(headers, 'return-path');
    const isEmptyReturn = returnPath === '<>' || returnPath === '';

    if (!isDSN && !isMailerDaemon && !isEmptyReturn) {
      return null;
    }

    // Extract original Message-ID from the bounce body
    const originalMessageId = this.extractOriginalMessageId(textBody, headers);

    // Extract bounce reason
    const reason = this.extractBounceReason(textBody);

    this.logger.log(
      `[EmailNormalizer] 🔴 Bounce detected — Original Message-ID: ${originalMessageId ?? 'unknown'}, Reason: ${reason}`,
    );

    return {
      isBounce: true,
      originalMessageId,
      reason,
    };
  }

  /**
   * Process a detected bounce: update message status and notify UI.
   */
  handleBounce(
    tenantId: string,
    originalMessageId: string | null,
    reason: string,
  ): void {
    if (!originalMessageId) {
      this.logger.warn(
        '[EmailNormalizer] Bounce without original Message-ID — cannot correlate',
      );
      return;
    }

    // Emit event to update message status → FAILED with reason
    this.eventEmitter.emit('email.bounce.detected', {
      tenantId,
      emailMessageId: originalMessageId,
      reason,
      detectedAt: new Date().toISOString(),
    });
  }

  // ── 3. Thread Correlation — Hybrid 3-Layer Strategy ────────────────────

  /**
   * Extract threading information from email headers.
   */
  extractThreadInfo(headers: Record<string, string | string[]>): {
    messageId: string;
    inReplyTo: string | null;
    references: string[];
  } {
    const messageId =
      this.getHeader(headers, 'message-id') ||
      `<generated-${Date.now()}@crm.local>`;
    const inReplyTo = this.getHeader(headers, 'in-reply-to') ?? null;

    const referencesRaw = this.getHeader(headers, 'references') ?? '';
    const references = referencesRaw
      .split(/\s+/)
      .filter((ref) => ref.startsWith('<') && ref.endsWith('>'));

    return { messageId, inReplyTo, references };
  }

  /**
   * Layer 1 — Custom CRM Header Check.
   * When CRM sends outbound email, it injects X-CRM-Thread-ID.
   * If the reply contains this header, we instantly know the conversation.
   */
  extractCrmThreadId(
    headers: Record<string, string | string[]>,
  ): string | null {
    return this.getHeader(headers, 'x-crm-thread-id') ?? null;
  }

  /**
   * Layer 2 — Signature Fence Scanner.
   * Scans the email body for the visible [ref:CRM-{conversationId}:ref] marker
   * embedded in the signature zone of previous CRM outbound emails.
   *
   * This survives forward/reply chains because it persists in quoted text.
   * Replaces the rejected hidden-watermark approach (deliverability risk).
   */
  extractSignatureFenceId(htmlBody: string): string | null {
    if (!htmlBody) return null;

    // Match [ref:CRM-{conversationId}:ref] pattern
    const match = /\[ref:CRM-([a-f0-9]{24}):ref\]/i.exec(htmlBody);
    return match ? match[1] : null;
  }

  /**
   * Layer 3 — Fuzzy Heuristic Matching (Last Resort).
   * Compares normalized subject, sender/recipient pairs, and temporal proximity.
   * Returns a confidence score (0-1). Only auto-merge above 0.8.
   */
  fuzzyMatchScore(
    inbound: { subject: string; from: string; to: string[]; timestamp: Date },
    existing: {
      subject: string;
      from: string;
      to: string[];
      lastMessageAt: Date;
    },
  ): number {
    let score = 0;

    // Subject similarity (weight: 0.5)
    const normalizedInbound = this.normalizeSubject(inbound.subject);
    const normalizedExisting = this.normalizeSubject(existing.subject);
    if (normalizedInbound === normalizedExisting) {
      score += 0.5;
    } else if (
      normalizedInbound.includes(normalizedExisting) ||
      normalizedExisting.includes(normalizedInbound)
    ) {
      score += 0.3;
    }

    // Sender/Recipient overlap (weight: 0.3)
    const inboundParticipants = new Set([inbound.from, ...inbound.to]);
    const existingParticipants = new Set([existing.from, ...existing.to]);
    const overlap = [...inboundParticipants].filter((p) =>
      existingParticipants.has(p),
    ).length;
    const total = new Set([...inboundParticipants, ...existingParticipants])
      .size;
    if (total > 0) {
      score += 0.3 * (overlap / total);
    }

    // Temporal proximity: within 7 days (weight: 0.2)
    const daysSinceLastMessage =
      Math.abs(inbound.timestamp.getTime() - existing.lastMessageAt.getTime()) /
      (1000 * 60 * 60 * 24);
    if (daysSinceLastMessage <= 1) {
      score += 0.2;
    } else if (daysSinceLastMessage <= 7) {
      score += 0.1;
    }

    return Math.round(score * 100) / 100;
  }

  // ── 4. Lazy Reply Guard — Soft-Link ────────────────────────────────────

  /**
   * Determine if a reply should create a soft-linked new conversation.
   *
   * Architecture Decision: Hard-Break replaced by Soft-Link
   *   - Old: boolean break → loses context permanently
   *   - New: soft_link → new conversation + parentConversationId FK + banner
   *
   * @param lastMessageDate - Last message timestamp in the existing conversation
   * @param conversationStatus - Current status of the existing conversation
   * @param lazyReplyBreakDays - Tenant-configurable SLA (default: 90 days)
   * @param existingConversationId - The ID of the existing conversation
   */
  shouldSoftLinkThread(
    lastMessageDate: Date | null,
    conversationStatus: string | null,
    lazyReplyBreakDays: number = 90,
    existingConversationId?: string,
  ): SoftLinkResult {
    // Rule 1: Conversation is Closed/Resolved → Soft-Link
    if (
      conversationStatus &&
      ['closed', 'resolved'].includes(conversationStatus.toLowerCase())
    ) {
      this.logger.debug(
        '[EmailNormalizer] Soft-link: conversation is closed/resolved',
      );
      return {
        action: 'soft_link',
        parentConversationId: existingConversationId,
      };
    }

    // Rule 2: Last message exceeds tenant's configured SLA
    if (lastMessageDate) {
      const daysSinceLastMessage =
        (Date.now() - lastMessageDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceLastMessage > lazyReplyBreakDays) {
        this.logger.debug(
          `[EmailNormalizer] Soft-link: last message was ${Math.floor(daysSinceLastMessage)} days ago ` +
            `(threshold: ${lazyReplyBreakDays} days)`,
        );
        return {
          action: 'soft_link',
          parentConversationId: existingConversationId,
        };
      }
    }

    return { action: 'continue' };
  }

  /**
   * @deprecated Use shouldSoftLinkThread() instead.
   * Maintained for backward compatibility during migration.
   */
  shouldBreakThread(
    lastMessageDate: Date | null,
    conversationStatus: string | null,
  ): boolean {
    const result = this.shouldSoftLinkThread(
      lastMessageDate,
      conversationStatus,
    );
    return result.action === 'soft_link';
  }

  // ── 5. Participant Extraction ──────────────────────────────────────────

  /**
   * Extract all email participants for GDPR contactIds mapping.
   * Includes: From, To, CC (excludes BCC since those are outbound-only).
   */
  extractParticipants(headers: Record<string, string | string[]>): {
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
  } {
    const from = this.normalizeEmail(this.getHeader(headers, 'from') ?? '');
    const to = this.parseEmailList(this.getHeader(headers, 'to') ?? '');
    const cc = this.parseEmailList(this.getHeader(headers, 'cc') ?? '');
    const bcc = this.parseEmailList(this.getHeader(headers, 'bcc') ?? '');

    return { from, to, cc, bcc };
  }

  /**
   * Generate a plain-text snippet from HTML body for preview/queue payload.
   * Strips tags, decodes entities, truncates to 500 chars.
   */
  generateSnippet(htmlBody: string, maxLength = 500): string {
    if (!htmlBody) return '';

    // Strip HTML tags
    let text = htmlBody.replace(/<[^>]+>/g, ' ');
    // Decode common HTML entities
    text = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    // Collapse whitespace
    text = text.replace(/\s+/g, ' ').trim();
    // Truncate
    return text.length > maxLength
      ? text.substring(0, maxLength) + '...'
      : text;
  }

  // ── Private Helpers ────────────────────────────────────────────────────

  getHeader(
    headers: Record<string, string | string[]>,
    key: string,
  ): string | null {
    const value = headers[key] || headers[key.toLowerCase()];
    if (!value) return null;
    return Array.isArray(value) ? value[0] : value;
  }

  private extractOriginalMessageId(
    textBody: string,
    headers: Record<string, string | string[]>,
  ): string | null {
    // Try In-Reply-To header first (most reliable for bounces)
    const inReplyTo = this.getHeader(headers, 'in-reply-to');
    if (inReplyTo) return inReplyTo;

    // Search body for Message-ID patterns
    const match = /Message-ID:\s*(<[^>]+>)/i.exec(textBody);
    return match ? match[1] : null;
  }

  private extractBounceReason(textBody: string): string {
    // Common patterns in DSN bodies
    const patterns = [
      /Diagnostic-Code:\s*smtp;\s*(.+)/i,
      /The email account that you tried to reach does not exist/i,
      /User unknown/i,
      /Mailbox not found/i,
      /over quota/i,
      /Message rejected/i,
      /550[\s-]+(.+)/i,
      /554[\s-]+(.+)/i,
    ];

    for (const pattern of patterns) {
      const match = textBody.match(pattern);
      if (match) {
        const reason = match[1] || match[0];
        return `Hard bounce: ${reason.trim().substring(0, 200)}`;
      }
    }

    return 'Delivery failed: Unable to deliver message';
  }

  /**
   * Normalize email subject for fuzzy matching.
   * Strips Re:, Fwd:, Fw:, and excess whitespace.
   */
  private normalizeSubject(subject: string): string {
    return (subject || '')
      .replace(/^(re|fwd|fw)\s*:\s*/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  normalizeEmail(raw: string): string {
    // Extract email from "Name <email@example.com>" format
    const match = /<([^>]+)>/.exec(raw);
    return (match ? match[1] : raw).toLowerCase().trim();
  }

  parseEmailList(raw: string): string[] {
    if (!raw) return [];
    return raw
      .split(',')
      .map((part) => this.normalizeEmail(part))
      .filter((email) => email.includes('@'));
  }
}
