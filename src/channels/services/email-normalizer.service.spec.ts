import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  EmailNormalizerService,
  SoftLinkResult,
} from './email-normalizer.service';

describe('EmailNormalizerService', () => {
  let service: EmailNormalizerService;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  beforeEach(() => {
    eventEmitter = {
      emit: jest.fn(),
    } as any;
    service = new EmailNormalizerService(eventEmitter);
  });

  // ────────────────────────────────────────────────────────────────────────
  // 1. Auto-Responder Detection
  // ────────────────────────────────────────────────────────────────────────
  describe('isAutoResponder()', () => {
    it('should DROP emails with Auto-Submitted: auto-replied (RFC 3834)', () => {
      expect(
        service.isAutoResponder({ 'auto-submitted': 'auto-replied' }, true),
      ).toBe(true);
    });

    it('should NOT drop emails with Auto-Submitted: auto-generated', () => {
      expect(
        service.isAutoResponder({ 'auto-submitted': 'auto-generated' }, true),
      ).toBe(false);
    });

    it('should NOT drop emails with Auto-Submitted: no', () => {
      expect(service.isAutoResponder({ 'auto-submitted': 'no' }, true)).toBe(
        false,
      );
    });

    it('should DROP emails with X-Auto-Response-Suppress header', () => {
      expect(
        service.isAutoResponder({ 'x-auto-response-suppress': 'All' }, true),
      ).toBe(true);
    });

    it('should DROP emails with X-Autoreply header', () => {
      expect(service.isAutoResponder({ 'x-autoreply': 'yes' }, true)).toBe(
        true,
      );
    });

    it('should DROP emails with X-Autorespond header', () => {
      expect(service.isAutoResponder({ 'x-autorespond': 'yes' }, true)).toBe(
        true,
      );
    });

    it('should NOT drop emails with Precedence: bulk', () => {
      expect(service.isAutoResponder({ precedence: 'bulk' }, true)).toBe(false);
    });

    it('should DROP emails with Precedence: junk', () => {
      expect(service.isAutoResponder({ precedence: 'junk' }, true)).toBe(true);
    });

    it('should NOT drop emails with Precedence: list (mailing lists)', () => {
      expect(service.isAutoResponder({ precedence: 'list' }, true)).toBe(false);
    });

    it('should NOT drop emails with empty Return-Path (could be bounce)', () => {
      expect(service.isAutoResponder({ 'return-path': '<>' })).toBe(false);
    });

    it('should NOT drop normal emails without auto-responder headers', () => {
      expect(
        service.isAutoResponder({
          from: 'John <john@company.com>',
          to: 'sales@ourcrm.com',
          subject: 'Re: Quote request',
        }),
      ).toBe(false);
    });

    it('should handle case-insensitive Precedence values', () => {
      expect(service.isAutoResponder({ precedence: 'BULK' }, true)).toBe(false);
      expect(service.isAutoResponder({ precedence: 'Junk' }, true)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 2. Bounce Detection
  // ────────────────────────────────────────────────────────────────────────
  describe('detectBounce()', () => {
    it('should detect DSN bounces (multipart/report + delivery-status)', () => {
      const headers = {
        'content-type': 'multipart/report; report-type=delivery-status',
        from: 'MAILER-DAEMON@google.com',
      };
      const textBody = 'Diagnostic-Code: smtp; 550 5.1.1 User not found';
      const result = service.detectBounce(headers, textBody);

      expect(result).not.toBeNull();
      expect(result!.isBounce).toBe(true);
      expect(result!.reason).toContain('550 5.1.1 User not found');
    });

    it('should detect bounces from mailer-daemon sender', () => {
      const headers = { from: 'mailer-daemon@mx.example.com' };
      const textBody = 'Message rejected';
      const result = service.detectBounce(headers, textBody);

      expect(result).not.toBeNull();
      expect(result!.isBounce).toBe(true);
    });

    it('should detect bounces from postmaster sender', () => {
      const headers = { from: 'postmaster@mail.example.com' };
      const textBody = 'User unknown';
      const result = service.detectBounce(headers, textBody);

      expect(result).not.toBeNull();
      expect(result!.isBounce).toBe(true);
    });

    it('should detect bounces via empty Return-Path', () => {
      const headers = { 'return-path': '<>', from: 'noreply@system.com' };
      const textBody = 'Mailbox not found';
      const result = service.detectBounce(headers, textBody);

      expect(result).not.toBeNull();
    });

    it('should extract original Message-ID from In-Reply-To header', () => {
      const headers = {
        from: 'mailer-daemon@google.com',
        'in-reply-to': '<original-123@crm.local>',
      };
      const textBody = 'The email account does not exist';
      const result = service.detectBounce(headers, textBody);

      expect(result!.originalMessageId).toBe('<original-123@crm.local>');
    });

    it('should extract original Message-ID from body when no In-Reply-To', () => {
      const headers = { from: 'mailer-daemon@google.com' };
      const textBody =
        'Original Message-ID: <abc-456@crm.local>\nDelivery failed.';
      const result = service.detectBounce(headers, textBody);

      expect(result!.originalMessageId).toBe('<abc-456@crm.local>');
    });

    it('should return null for normal emails (not a bounce)', () => {
      const headers = {
        from: 'customer@company.com',
        'content-type': 'text/html',
      };
      const result = service.detectBounce(headers, 'Hello, I have a question.');

      expect(result).toBeNull();
    });

    it('should extract specific bounce reasons from DSN patterns', () => {
      const headers = { from: 'mailer-daemon@host.com' };
      const textBody =
        '550-5.1.1 The email account that you tried to reach does not exist';
      const result = service.detectBounce(headers, textBody);

      expect(result!.reason).toContain('Hard bounce');
    });

    it('should provide a default reason when no pattern matches', () => {
      const headers = { from: 'mailer-daemon@host.com' };
      const textBody = 'Something went wrong with your message.';
      const result = service.detectBounce(headers, textBody);

      expect(result!.reason).toBe('Delivery failed: Unable to deliver message');
    });
  });

  describe('handleBounce()', () => {
    it('should emit bounce event with correct payload', () => {
      service.handleBounce(
        'tenant-1',
        '<msg-123@crm.local>',
        '550 User not found',
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith('email.bounce.detected', {
        tenantId: 'tenant-1',
        emailMessageId: '<msg-123@crm.local>',
        reason: '550 User not found',
        detectedAt: expect.any(String),
      });
    });

    it('should NOT emit event when originalMessageId is null', () => {
      service.handleBounce('tenant-1', null, 'Unknown bounce');

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 3. Thread Correlation — Hybrid 3-Layer Strategy
  // ────────────────────────────────────────────────────────────────────────
  describe('extractThreadInfo()', () => {
    it('should extract message-id, in-reply-to and references', () => {
      const headers = {
        'message-id': '<msg-100@example.com>',
        'in-reply-to': '<msg-99@example.com>',
        references: '<msg-98@example.com> <msg-99@example.com>',
      };
      const result = service.extractThreadInfo(headers);

      expect(result.messageId).toBe('<msg-100@example.com>');
      expect(result.inReplyTo).toBe('<msg-99@example.com>');
      expect(result.references).toEqual([
        '<msg-98@example.com>',
        '<msg-99@example.com>',
      ]);
    });

    it('should generate a message-id when none exists', () => {
      const result = service.extractThreadInfo({});
      expect(result.messageId).toMatch(/^<generated-\d+@crm\.local>$/);
    });

    it('should return null inReplyTo and empty references when not present', () => {
      const result = service.extractThreadInfo({
        'message-id': '<test@example.com>',
      });
      expect(result.inReplyTo).toBeNull();
      expect(result.references).toEqual([]);
    });

    it('should filter out malformed references (no angle brackets)', () => {
      const headers = {
        'message-id': '<m@e.com>',
        references: '<valid@e.com> broken-ref abc <another@e.com>',
      };
      const result = service.extractThreadInfo(headers);
      expect(result.references).toEqual(['<valid@e.com>', '<another@e.com>']);
    });
  });

  describe('extractCrmThreadId() — Layer 1: Custom Header', () => {
    it('should extract X-CRM-Thread-ID from headers', () => {
      const result = service.extractCrmThreadId({
        'x-crm-thread-id': '507f1f77bcf86cd799439011',
      });
      expect(result).toBe('507f1f77bcf86cd799439011');
    });

    it('should return null when no CRM header is present', () => {
      const result = service.extractCrmThreadId({ from: 'test@test.com' });
      expect(result).toBeNull();
    });
  });

  describe('extractSignatureFenceId() — Layer 2: Signature Fence', () => {
    it('should extract conversation ID from signature fence marker', () => {
      const html = `
        <div>Thank you for your email!</div>
        <p style="font-size:9px; color:#aaa;">
          [ref:CRM-507f1f77bcf86cd799439011:ref]
        </p>
      `;
      const result = service.extractSignatureFenceId(html);
      expect(result).toBe('507f1f77bcf86cd799439011');
    });

    it('should handle fence in nested reply chain (quoted body)', () => {
      const html = `
        <div>My reply.</div>
        <blockquote>
          <div>Original message</div>
          <p>[ref:CRM-aabbccdd11223344aabbccdd:ref]</p>
        </blockquote>
      `;
      const result = service.extractSignatureFenceId(html);
      expect(result).toBe('aabbccdd11223344aabbccdd');
    });

    it('should return null when no fence marker exists', () => {
      const html = '<div>Normal email without any CRM signature.</div>';
      expect(service.extractSignatureFenceId(html)).toBeNull();
    });

    it('should return null for empty/null body', () => {
      expect(service.extractSignatureFenceId('')).toBeNull();
      expect(service.extractSignatureFenceId(null as any)).toBeNull();
    });
  });

  describe('fuzzyMatchScore() — Layer 3: Fuzzy Heuristic', () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3600 * 1000);
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 3600 * 1000);
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 3600 * 1000);

    it('should score 1.0 for exact match on subject, participants, and time', () => {
      const score = service.fuzzyMatchScore(
        {
          subject: 'Re: Quote Request',
          from: 'a@test.com',
          to: ['b@test.com'],
          timestamp: now,
        },
        {
          subject: 'Quote Request',
          from: 'b@test.com',
          to: ['a@test.com'],
          lastMessageAt: oneHourAgo,
        },
      );
      expect(score).toBe(1.0);
    });

    it('should score high (>= 0.8) for same subject, same participants, recent', () => {
      const score = service.fuzzyMatchScore(
        {
          subject: 'Fwd: Re: Quote Request',
          from: 'a@test.com',
          to: ['b@test.com'],
          timestamp: now,
        },
        {
          subject: 'Quote Request',
          from: 'b@test.com',
          to: ['a@test.com'],
          lastMessageAt: oneHourAgo,
        },
      );
      expect(score).toBeGreaterThanOrEqual(0.8);
    });

    it('should score low for completely different subject and participants', () => {
      const score = service.fuzzyMatchScore(
        {
          subject: 'Invoice #123',
          from: 'x@company.com',
          to: ['y@company.com'],
          timestamp: now,
        },
        {
          subject: 'Meeting notes',
          from: 'z@other.com',
          to: ['w@other.com'],
          lastMessageAt: oneHourAgo,
        },
      );
      expect(score).toBeLessThan(0.3);
    });

    it('should reduce temporal score for messages > 7 days apart', () => {
      const recentScore = service.fuzzyMatchScore(
        {
          subject: 'Quote',
          from: 'a@test.com',
          to: ['b@test.com'],
          timestamp: now,
        },
        {
          subject: 'Quote',
          from: 'b@test.com',
          to: ['a@test.com'],
          lastMessageAt: oneHourAgo,
        },
      );
      const oldScore = service.fuzzyMatchScore(
        {
          subject: 'Quote',
          from: 'a@test.com',
          to: ['b@test.com'],
          timestamp: now,
        },
        {
          subject: 'Quote',
          from: 'b@test.com',
          to: ['a@test.com'],
          lastMessageAt: tenDaysAgo,
        },
      );
      expect(recentScore).toBeGreaterThan(oldScore);
    });

    it('should give partial score for subject containment', () => {
      const score = service.fuzzyMatchScore(
        {
          subject: 'Re: Updated Quote Request',
          from: 'a@test.com',
          to: ['b@test.com'],
          timestamp: now,
        },
        {
          subject: 'Quote Request',
          from: 'b@test.com',
          to: ['a@test.com'],
          lastMessageAt: threeDaysAgo,
        },
      );
      // subject containment (0.3) + partial participants + temporal
      expect(score).toBeGreaterThan(0.3);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 4. Soft-Link Thread Break (Lazy Reply Guard)
  // ────────────────────────────────────────────────────────────────────────
  describe('shouldSoftLinkThread()', () => {
    it('should soft-link when conversation is CLOSED', () => {
      const result: SoftLinkResult = service.shouldSoftLinkThread(
        new Date(),
        'closed',
        90,
        'conv-abc',
      );
      expect(result.action).toBe('soft_link');
      expect(result.parentConversationId).toBe('conv-abc');
    });

    it('should soft-link when conversation is RESOLVED', () => {
      const result = service.shouldSoftLinkThread(
        new Date(),
        'resolved',
        90,
        'conv-xyz',
      );
      expect(result.action).toBe('soft_link');
      expect(result.parentConversationId).toBe('conv-xyz');
    });

    it('should soft-link when last message exceeds SLA (lazyReplyBreakDays)', () => {
      const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000); // 100 days ago
      const result = service.shouldSoftLinkThread(
        longAgo,
        'active',
        90,
        'conv-old',
      );

      expect(result.action).toBe('soft_link');
      expect(result.parentConversationId).toBe('conv-old');
    });

    it('should CONTINUE when conversation is active and within SLA', () => {
      const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
      const result = service.shouldSoftLinkThread(recent, 'active', 90);

      expect(result.action).toBe('continue');
      expect(result.parentConversationId).toBeUndefined();
    });

    it('should CONTINUE when lastMessageDate is null and conversation is active', () => {
      const result = service.shouldSoftLinkThread(null, 'active', 90);
      expect(result.action).toBe('continue');
    });

    it('should default to 90 days when lazyReplyBreakDays is omitted', () => {
      const ninetyOneDaysAgo = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
      const result = service.shouldSoftLinkThread(
        ninetyOneDaysAgo,
        'active',
        undefined,
        'conv-1',
      );

      expect(result.action).toBe('soft_link');
    });

    it('should respect custom lazyReplyBreakDays (e.g., 180 days for Enterprise)', () => {
      const hundredDaysAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
      const result = service.shouldSoftLinkThread(
        hundredDaysAgo,
        'active',
        180,
        'conv-2',
      );

      // 100 days < 180 days → continue
      expect(result.action).toBe('continue');
    });

    it('should case-insensitively check conversation status', () => {
      const result = service.shouldSoftLinkThread(
        new Date(),
        'CLOSED',
        90,
        'conv-3',
      );
      expect(result.action).toBe('soft_link');
    });
  });

  describe('shouldBreakThread() — deprecated', () => {
    it('should delegate to shouldSoftLinkThread and return boolean', () => {
      const result = service.shouldBreakThread(new Date(), 'closed');
      expect(result).toBe(true);

      const result2 = service.shouldBreakThread(new Date(), 'active');
      expect(result2).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 5. Participant Extraction
  // ────────────────────────────────────────────────────────────────────────
  describe('extractParticipants()', () => {
    it('should extract from, to, cc, bcc from headers', () => {
      const result = service.extractParticipants({
        from: 'John Doe <john@example.com>',
        to: 'Jane <jane@example.com>, Bob <bob@example.com>',
        cc: 'Manager <mgr@example.com>',
        bcc: 'secret@hidden.com',
      });

      expect(result.from).toBe('john@example.com');
      expect(result.to).toEqual(['jane@example.com', 'bob@example.com']);
      expect(result.cc).toEqual(['mgr@example.com']);
      expect(result.bcc).toEqual(['secret@hidden.com']);
    });

    it('should handle plain email (no display name)', () => {
      const result = service.extractParticipants({
        from: 'plain@email.com',
        to: 'recipient@example.com',
      });
      expect(result.from).toBe('plain@email.com');
      expect(result.to).toEqual(['recipient@example.com']);
    });

    it('should return empty arrays when headers are missing', () => {
      const result = service.extractParticipants({});
      expect(result.from).toBe('');
      expect(result.to).toEqual([]);
      expect(result.cc).toEqual([]);
      expect(result.bcc).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 6. Snippet Generation
  // ────────────────────────────────────────────────────────────────────────
  describe('generateSnippet()', () => {
    it('should strip HTML tags and generate plain text', () => {
      const html = '<h1>Hello</h1><p>Welcome to <b>CRM</b>!</p>';
      const snippet = service.generateSnippet(html);
      expect(snippet).toBe('Hello Welcome to CRM !');
    });

    it('should decode HTML entities', () => {
      const html = '<p>A &amp; B &lt;C&gt; &quot;D&quot; &#39;E&#39;</p>';
      const snippet = service.generateSnippet(html);
      expect(snippet).toContain('A & B <C> "D" \'E\'');
    });

    it('should truncate to maxLength and append "..."', () => {
      const longHtml = '<p>' + 'A'.repeat(600) + '</p>';
      const snippet = service.generateSnippet(longHtml, 100);
      expect(snippet.length).toBe(103); // 100 + '...'
      expect(snippet.endsWith('...')).toBe(true);
    });

    it('should return empty string for empty input', () => {
      expect(service.generateSnippet('')).toBe('');
    });

    it('should decode &nbsp; to spaces', () => {
      const html = '<p>Word1&nbsp;&nbsp;Word2</p>';
      const snippet = service.generateSnippet(html);
      expect(snippet).toContain('Word1');
      expect(snippet).toContain('Word2');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 7. Helper Methods
  // ────────────────────────────────────────────────────────────────────────
  describe('normalizeEmail()', () => {
    it('should extract email from "Name <email>" format', () => {
      expect(service.normalizeEmail('John Doe <john@example.com>')).toBe(
        'john@example.com',
      );
    });

    it('should handle plain email format', () => {
      expect(service.normalizeEmail('plain@email.com')).toBe('plain@email.com');
    });

    it('should lowercase the email', () => {
      expect(service.normalizeEmail('UPPER@EXAMPLE.COM')).toBe(
        'upper@example.com',
      );
    });
  });

  describe('parseEmailList()', () => {
    it('should parse comma-separated list', () => {
      const result = service.parseEmailList(
        'a@test.com, B <b@test.com>, c@test.com',
      );
      expect(result).toEqual(['a@test.com', 'b@test.com', 'c@test.com']);
    });

    it('should filter out entries without @', () => {
      const result = service.parseEmailList('valid@test.com, invalid-address');
      expect(result).toEqual(['valid@test.com']);
    });

    it('should return empty array for empty string', () => {
      expect(service.parseEmailList('')).toEqual([]);
    });
  });

  describe('getHeader()', () => {
    it('should return first value from array headers', () => {
      expect(
        service.getHeader(
          { from: ['first@test.com', 'second@test.com'] },
          'from',
        ),
      ).toBe('first@test.com');
    });

    it('should return string value directly', () => {
      expect(service.getHeader({ subject: 'Hello' }, 'subject')).toBe('Hello');
    });

    it('should return null for missing headers', () => {
      expect(service.getHeader({}, 'missing')).toBeNull();
    });
  });
});
