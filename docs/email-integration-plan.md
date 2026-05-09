# 📧 Enterprise Email Integration — Final Architecture & Implementation

> **Status:** ✅ Production-Ready (Phase 1 + 2 + 3 Implemented)  
> **Version:** 2.0 — Final  
> **Last updated:** 2026-05-04  
> **Author:** Antigravity AI + Product Team

---

## Table of Contents

1. [Overview](#1-overview)
2. [System Architecture](#2-system-architecture)
3. [Phase 1 — SMTP Outbound + Infrastructure](#3-phase-1--smtp-outbound--infrastructure)
4. [Phase 2 — IMAP Inbound Engine](#4-phase-2--imap-inbound-engine)
5. [Phase 3 — Frontend Integration & Reply Engine](#5-phase-3--frontend-integration--reply-engine)
6. [Sad Path Defenders](#6-sad-path-defenders)
7. [Database Schema](#7-database-schema)
8. [Dynamic Polling Strategy](#8-dynamic-polling-strategy)
9. [GDPR & Compliance](#9-gdpr--compliance)
10. [Contact Deduplication](#10-contact-deduplication)
11. [Frontend i18n & Dark Mode](#11-frontend-i18n--dark-mode)
12. [Configuration Guide](#12-configuration-guide)
13. [File Map](#13-file-map)
14. [Deferred (Future)](#14-deferred-future)
15. [Appendix: Devil's Advocate Rules](#15-appendix-devils-advocate-rules)

---

## 1. Overview

### Problem Statement

The CRM needs a first-class Enterprise Email channel that supports:

- **Outbound**: Sending emails via SMTP with App Password / OAuth2 credentials
- **Inbound**: Real-time sync via IMAP polling with dynamic interval strategy
- **Enterprise-grade**: Multi-tenant, GDPR-compliant, with proper MIME handling, contact deduplication, and security filtering

### What Was Actually Built

| Area                                          | Implemented | Status     |
| --------------------------------------------- | ----------- | ---------- |
| SMTP Provider Registry                        | ✅           | Production |
| SMTP Adapter (verify + send)                  | ✅           | Production |
| IMAP Poller Service (dynamic interval)        | ✅           | Production |
| Email Normalizer (auto-reply, bounce, thread) | ✅           | Production |
| Attachment Security Gateway                   | ✅           | Production |
| Outbound Queue + Throttler                    | ✅           | Production |
| Email Signature Management                    | ✅           | Production |
| Email Tracking (Bot-Resilient)                | ✅           | Production |
| GDPR Multi-Party Deletion                     | ✅           | Production |
| Historical Sync (Dual-Mode)                   | ✅           | Production |
| MIME Parsing (mailparser)                     | ✅           | Production |
| Contact Deduplication                         | ✅           | Production |
| Frontend Split View + Full-Screen             | ✅           | Production |
| TipTap WYSIWYG Compose                        | ✅           | Production |
| i18n (EN + VI)                                | ✅           | Production |
| Dark Mode Support                             | ✅           | Production |

### Key Design Decisions (Final)

| Decision                           | Rationale                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Logic Tách, UI Gộp**             | Email conversations are separate entities, unified under Contact Profile in the UI                                                        |
| **IMAP Polling (not Webhook)**     | Practical choice for MVP — App Password auth works across all providers without OAuth2 dance. Webhook (Pub/Sub) deferred to future phase. |
| **mailparser for MIME**            | Industry-standard library handles Quoted-Printable, Base64, multipart MIME. Replaced raw string parsing.                                  |
| **Separate Storage**               | HTML body in `email_contents`, metadata in `email_metadata`. Does not bloat the real-time chat `messages` pipeline.                       |
| **Email-based Contact Dedup**      | Prevents N shadow contacts from same sender. Checks `emails[]` array + `omniIdentities.senderId` before creating.                         |
| **DOMPurify + Style Preservation** | Allow `<style>` tags in sanitization so email CSS renders correctly (like Gmail). Removed Tailwind `prose` overrides.                     |
| **Deterministic Avatars**          | Hash-based color generation for contacts — no external avatar services. Consistent across sessions.                                       |

---

## 2. System Architecture

### Production Architecture (Implemented)

```text
┌──────────────────────────────────────────────────────────────────┐
│                        TENANT ADMIN                              │
│                                                                  │
│     Channel Config UI ──→ PROVIDER_REGISTRY (SMTP config)        │
│            │                                                     │
│   [App Password / Credentials] ──→ Encrypted in MongoDB         │
└──────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │                   │
          OUTBOUND (SMTP)        INBOUND (IMAP Poll)
                    │                   │
           ┌───────┴────────┐   ┌──────┴─────────────────────────┐
           │ TransportPool  │   │ ImapPollerService               │
           │ (Nodemailer)   │   │ (Dynamic Interval: 2m/15m)     │
           │                │   │                                 │
           │ - SMTP Verify  │   │ - Redis distributed lock       │
           │ - Send w/      │   │ - mailparser (MIME decode)     │
           │   throttling   │   │ - Business hours aware         │
           └────────────────┘   │ - UID-based high watermark     │
                                └──────┬─────────────────────────┘
                                       │
                              ┌────────┴─────────┐
                              │ EmailNormalizer   │
                              │                   │
                              │ ┌─Auto-responder──┤
                              │ │  filter (DROP)  │
                              │ ├─Bounce handler──┤
                              │ │  (FAILED+reason)│
                              │ ├─Lazy Reply guard┤
                              │ │  (Soft-Link)    │
                              │ └─Thread correlate┤
                              │    (In-Reply-To)  │
                              └────────┬──────────┘
                                       │
                    ┌──────────────────┴──────────────────┐
                    │          ConversationService         │
                    │                                      │
                    │ - Contact deduplication (emails[])   │
                    │ - Shadow contact creation            │
                    │ - addEmailIfMissing ($addToSet)      │
                    │ - Omni message creation              │
                    └──────────────────┬──────────────────┘
                                       │
                    ┌──────────────────┴──────────────────┐
                    │            MongoDB                   │
                    │                                      │
                    │  email_contents   email_metadata     │
                    │  (HTML, Text,     (Message-ID,       │
                    │   contactIds[])    CC/BCC, bounce)   │
                    │                                      │
                    │  omni_conversations  omni_messages   │
                    │  contacts (with emails[] + dedup)    │
                    └─────────────────────────────────────┘
```

### Frontend Architecture (Implemented)

```text
┌─────────────────────────────────────────────────────────────┐
│                     ChatWindow.tsx                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ EmailMessageCard.tsx (for channelType === 'Email')   │   │
│  │                                                      │   │
│  │  ┌─────────────┐  ┌────────────────────────────────┐│   │
│  │  │ Email Header │  │ .email-body-content            ││   │
│  │  │ From/To/CC   │  │ (white bg, original CSS kept)  ││   │
│  │  │ Subject      │  │ DOMPurify + <style> allowed    ││   │
│  │  └─────────────┘  └────────────────────────────────┘│   │
│  │                                                      │   │
│  │  ┌───────────────────────────────────────────────┐  │   │
│  │  │ Split View: EmailComposePanel.tsx             │  │   │
│  │  │ TipTap WYSIWYG (Table, Link, Image)          │  │   │
│  │  │ Reply / Reply All / Forward                    │  │   │
│  │  │ Attachment security (client-side blocklist)    │  │   │
│  │  └───────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌────────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ EmailQuotaWidget│  │ SignatureEdit │  │ HistSyncPanel  │  │
│  └────────────────┘  └──────────────┘  └────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Phase 1 — SMTP Outbound + Infrastructure

### 3.1 SMTP Provider Registry

File: `src/channels/domain/channel-provider-registry.ts`

Added `smtp` provider to `PROVIDER_REGISTRY` with:

- **Credential Auth**: App Password (primary for current implementation)
- **Setting Fields** (stored as `publicSettings`):
  - `providerType` — google_workspace | office365 | custom_imap_smtp
  - `fromEmail` — Sender email address
  - `fromName` — Display name
  - `smtpHost`, `smtpPort` — SMTP server config
  - `imapHost`, `imapPort` — IMAP server config (for inbound)
  - `isDefault` — Default sending account flag

### 3.2 SMTP Adapter

File: `src/channels/adapters/smtp.adapter.ts`

```typescript
// Connection verification flow:
// 1. Create nodemailer transport from credentials
// 2. Call transport.verify() to test SMTP auth
// 3. Auto-detect SSL (port 465) vs STARTTLS (port 587)
// 4. Return user-friendly error messages on failure
```

**Supported providers (tested):**

- Gmail (smtp.gmail.com:587) — App Password
- Outlook/Office365 (smtp.office365.com:587)
- Custom SMTP servers

### 3.3 Transport Pool

File: `src/channels/transport-pool.service.ts`

- Connection pooling for Nodemailer transports
- Auto-creates transport on first use, caches for reuse
- Handles connection errors and reconnection

### 3.4 Outbound Queue & Throttler

File: `src/channels/services/outbound-queue.service.ts`

- **Per-Second Throttle**: 1-2 emails/second/tenant, preventing rate limit bans
- **Daily Quota Guard**: Redis counter `outbound:daily:{tenantId}:{configId}:{date}` (TTL: 24h)
- **Bulk Campaign Block**: If recipient count > 500, immediately returns error:
  > *"⚠️ This campaign exceeds the safe daily limit. Please use Marketing Email (SendGrid/SES) for bulk campaigns."*

### 3.5 Attachment Security Gateway

File: `src/channels/services/attachment-security.service.ts`

- **Extension Blocklist**: `.exe`, `.bat`, `.cmd`, `.vbs`, `.js`, `.msi`, `.ps1`, `.scr`, `.dll`, `.docm`, `.xlsm`, etc.
- **Size Limit**: 25 MB per attachment
- **CID Classification**: Inline images < 10KB kept as Base64 data URIs (no storage upload)
- **Unit Tests**: `attachment-security.service.spec.ts` — full coverage

### 3.6 Email Signature Management

File: `src/channels/services/email-signature.service.ts`

- Per-channel, per-tenant signature storage
- TipTap rich-text WYSIWYG editor in Channel Settings UI
- Auto-appended to outbound emails with toggle to disable per-email

---

## 4. Phase 2 — IMAP Inbound Engine

### 4.1 IMAP Poller Service

File: `src/channels/services/imap-poller.service.ts`

**Core responsibilities:**
1. Connects to IMAP servers using `imapflow` library
2. Uses Redis distributed locks to prevent double-polling across cluster nodes
3. Dynamic polling interval based on business hours + activity (see Section 8)
4. UID-based high watermark (`lastSeenUid`) to only fetch new emails
5. Stream-based email fetching for memory efficiency
6. **Strict Read-Only Fetch**: Relies purely on UID tracking. Does NOT mutate the `\Seen` flag during inbound polling to prevent disruption of user email workflows.
7. **Idempotency & Connection Pooling**: Uses envelope metadata checks to skip parsing duplicates, and utilizes connection pooling for improved throughput.

**MIME Parsing Pipeline (mailparser):**
```typescript
import { simpleParser, ParsedMail } from 'mailparser';

// Flow:
// 1. Fetch raw email bytes via IMAP FETCH
// 2. simpleParser() handles:
//    - Quoted-Printable decoding (=F0=9F=93=A2 → 📢)
//    - Base64 content decoding
//    - Multipart MIME boundary parsing
//    - HTML + plainText extraction
//    - Attachment extraction with CID mapping
// 3. Structured ParsedMail → EmailNormalizer → MongoDB
```

**Why mailparser?** Previous raw string parsing failed on Quoted-Printable encoded emails (e.g., MailChimp newsletters), producing garbled output like `=F0=9F=93=A2 Campaign Info= rmation`. `mailparser` is the Node.js industry standard for robust MIME decoding.

### 4.1.5 Two-Way Read State Sync (Background Worker)

File: `src/queue/read-state-sync/read-state-sync.processor.ts`

While the default behavior is read-only, we provide an **opt-in Two-Way Read State Sync** feature:
- Triggered dynamically when an agent reads/unreads an email in the CRM UI.
- Pushes a job to the `read-state-sync` BullMQ queue.
- The `ReadStateSyncProcessor` executes the sync using `imapflow`, checking the `syncReadState` toggle in the tenant's `ChannelConfig`.
- Employs Redis locks (`readstate:lock:{messageId}`) and UID validity fallbacks (searching by `Message-ID` header if the UID is stale).
- Features robust authentication error handling to prevent credential-related account lockouts.

### 4.2 Email Normalizer Service

File: `src/channels/services/email-normalizer.service.ts`

The **Sad Path Defender** — classifies and processes raw emails:

**Classification Result:**
```typescript
interface NormalizeResult {
  action: 'process' | 'drop' | 'bounce';
  subject: string;
  htmlBody: string;
  plainText: string;
  snippet: string;
  from: string;
  to: string[];
  cc: string[];
  threadId?: string;
  inReplyTo?: string;
  references?: string[];
  originalMessageId?: string;
  bounceReason?: string;
}
```

**Unit Tests:** `email-normalizer.service.spec.ts` — comprehensive coverage for auto-responder, bounce, thread correlation, and soft-link scenarios.

### 4.3 Email Inbound Listener

File: `src/channels/mail-inbound/email-inbound.listener.ts`

- Listens to IMAP poller events
- Routes normalized emails through `ConversationService`
- Handles thread correlation (In-Reply-To → existing conversation lookup)

### 4.4 Historical Sync (Dual-Mode)

File: `src/channels/services/historical-sync.service.ts`

**Mode A — Contact-Enriched**: Syncs emails where participants match existing CRM contacts.

**Mode B — Auto-Discover**: Syncs recent emails (configurable 7-90 days), creates `PendingContact` records for new senders.

**UI:** `HistoricalSyncPanel.tsx` with:
- Mode selection cards
- Day-range selector (7/14/30/60/90 days)
- Real-time progress bar (emails imported, pending contacts, threads processed)
- Error handling with retry

### 4.5 Email Tracking (Bot-Resilient)

File: `src/channels/services/email-tracking.service.ts`  
Controller: `src/channels/email-tracking.controller.ts`

**Bot detection signals (any match → `source: 'bot'`):**
- User-Agent contains: `Googlebot`, `Mimecast`, `Proofpoint`, etc.
- IP in known proxy CIDR ranges (Apple, Google, AWS, Microsoft)
- Multiple hits within 30 seconds (bot scan pattern)
- Hit within 5 seconds of dispatch (pre-fetch)

**UI Label:** **"📬 Likely Opened"** — never "Opened" (communicates inherent uncertainty).

### 4.6 GDPR Email Service

File: `src/channels/services/gdpr-email.service.ts`

- Multi-party deletion via `$pull` on `contactIds[]`
- Orphan cleanup (delete document when `contactIds` is empty)
- Cascade to `email_metadata` when parent `email_contents` deleted

### 4.7 Email Channel Settings

File: `src/channels/services/email-channel-settings.service.ts`  
Controller: `src/channels/email-settings.controller.ts`

- Tenant-level email configuration management (`DynamicFormModal` in the frontend)
- Dynamic polling settings: `syncReadState` (opt-in 2-way read sync), `initialSyncDays`, and `blockAutoResponders`
- Signature CRUD operations
- Quota configuration

---

## 5. Phase 3 — Frontend Integration & Reply Engine

### 5.1 EmailMessageCard & Split View

Path: `src/features/omni-channel/ui/components/email/EmailMessageCard.tsx`

- **Email-native rendering**: Replaces chat bubbles with rich email cards when `channelType === 'Email'`
- **DOMPurify with `<style>` preservation**: `ADD_TAGS: ['style', 'link']` ensures email CSS renders correctly (like Gmail)
- **`.email-body-content` CSS**: Forces white background with black text defaults, preserving inline styles from original email HTML
- **Split View**: Side-by-side reading pane + compose panel when replying
- **Full-Screen Modal**: Expand button for complex HTML emails (pricing tables, multi-signature threads)
- **Soft-Link Banner**: Shows contextual link to parent conversation for old-thread replies
- **Tracking Badge**: `<Eye /> 📬 Likely Opened` for tracked emails
- **BCC Privacy Badge**: `<Lock />` indicator when BCC recipients exist

### 5.2 TipTap WYSIWYG Compose

Path: `src/features/omni-channel/ui/components/email/EmailComposePanel.tsx`

**Extensions:**
- `StarterKit` (paragraphs, headings, lists, bold/italic)
- `@tiptap/extension-underline`
- `@tiptap/extension-link`
- `@tiptap/extension-image`
- `@tiptap/extension-table` + `table-row` + `table-cell` + `table-header`

**Features:**
- Reply / Reply All / Forward modes with auto-populated address fields
- Bcc toggle with separate visual section
- Subject line management (auto-prefix Re:/Fwd:)
- Toolbar: Bold, Italic, Underline, Link, Table (insert/add row/add col/delete), Heading, List
- Attachment picker with client-side security blocklist + size validation
- Signature section with show/hide toggle
- RFC-compliant threading (In-Reply-To + References headers)

### 5.3 Email Quota Widget

Path: `src/features/omni-channel/ui/components/email/EmailQuotaWidget.tsx`

- Real-time daily quota usage bar (polls every 60s)
- Color-coded: green (< 80%) → amber (80-95%) → red (> 95%)
- Warning icon at danger level

### 5.4 Email Signature Editor

Path: `src/features/omni-channel/ui/components/email/EmailSignatureEditor.tsx`

- TipTap-based rich text editor for signature creation
- Save/delete with toast notifications
- Unsaved changes indicator
- Footer note: "This signature will be automatically appended..."

### 5.5 Store Alignment

Path: `src/features/omni-channel/store/useOmniStore.ts`

- `ChannelType` union includes `'Email'`
- `emailContents` cache map (keyed by message ID)
- `fetchEmailContent(contentId, messageId)` with memoization
- `sendEmailReply(conversationId, payload)` action

### 5.6 Email API Service

Path: `src/features/omni-channel/services/emailApi.ts`

- `getEmailContent(messageId)` — Fetch full HTML body
- `getDailyQuota(configId)` — Quota stats
- `getSignatureByConfig(configId)` — Fetch signature
- `upsertSignature(configId, html)` — Create/update signature
- `deleteSignature(configId)` — Delete signature
- `startHistoricalSync(configId, mode, maxAgeDays)` — Trigger sync
- `getSyncProgress(jobId)` — Poll sync progress

### 5.7 Email Styles

Path: `src/features/omni-channel/ui/components/email/email-styles.css`

**Key CSS strategies:**
- `.email-body-content`: White background + black text baseline (Gmail-like)
- Inline styles from email HTML **always take priority** (no `prose` override)
- TipTap table styles with resize handles
- Full-screen modal animation
- ProseMirror focus and placeholder styles

---

## 6. Sad Path Defenders

### 6.1 Auto-Responder Filter

**Headers scanned:**
- `Auto-Submitted: auto-replied` or `auto-generated`
- `X-Autoreply: yes`
- `Precedence: bulk` or `junk`

**Action:** `DROP` — message silently discarded.

### 6.2 Bounce Handler

**Detection:**
- Sender contains `mailer-daemon@` or `postmaster@`
- `Content-Type` contains `multipart/report` or `delivery-status`

**Processing:**
1. Extract original `Message-ID` from DSN body
2. Extract bounce reason (e.g., "550 User not found")
3. Return `action: 'bounce'` with `bounceReason`

**UI:** Original sent message shows `FAILED` status with tooltip.

### 6.3 Lazy Reply Guard — Soft-Link Thread Break

**Rules:**
1. Reply older than `tenantConfig.lazyReplyBreakDays` (default 90-180 days) OR referenced conversation is `CLOSED`/`RESOLVED`:
   - Create **new conversation** with `parentConversationId` FK
   - UI banner: *"📎 This reply is connected to a thread from 6 months ago. [View original context →]"*
2. Original conversation remains read-only in archive state

### 6.4 Thread Correlation (Hybrid 3-Layer)

**Layer 1 — Custom RFC Headers (Primary):**
```
X-CRM-Thread-ID: {conversationId}
X-CRM-Tenant-ID: {tenantId}
```

**Layer 2 — Visible Signature Fence (Fallback):**
```html
<p style="font-size:9px; color:#aaa;">[ref:CRM-{conversationId}:ref]</p>
```

**Layer 3 — Fuzzy Heuristic Matching (Last Resort):**
Subject similarity (Levenshtein ≤ 20%) + Sender/Recipient pair + temporal proximity.

---

## 7. Database Schema

### Storage Architecture

```
┌─────────────────────────┐
│     omni_messages        │  ← Lightweight: text preview, sender, timestamp
│     (existing pipeline)  │     metadata.emailContentId → email_contents
├─────────────────────────┤
│     email_contents       │  ← Heavy: Full HTML, plain text, subject
│                          │     GDPR: contactIds[] for deletion
├─────────────────────────┤
│     email_metadata       │  ← Threading: Message-ID, In-Reply-To, References
│                          │     Participants: CC, BCC
│                          │     Diagnostics: bounceReason
├─────────────────────────┤
│     contacts             │  ← emails[] array for deduplication
│                          │     omniIdentities[] for channel mapping
│                          │     isShadow flag for auto-created contacts
└─────────────────────────┘
```

### `email_contents` Collection

File: `src/channels/infrastructure/persistence/document/entities/email-content.schema.ts`

```typescript
{
  messageId: string;       // Links to omni_messages
  tenantId: string;        // Multi-tenant isolation
  conversationId: string;  // Link to omni_conversations
  contactIds: string[];    // GDPR: all contacts mentioned
  subject: string;         // Email subject (indexed)
  htmlBody: string;        // Full HTML content (raw from mailparser)
  plainText: string;       // Plain text fallback
  snippet: string;         // First 200 chars for preview
  from: string;            // Sender address
  to: string[];            // Recipients
  cc: string[];            // CC recipients
  attachments: [];         // Inline + file attachments
  createdAt: Date;
}
```

**Indexes:**
- Text index on `subject` + `plainText`
- Compound: `{ tenantId, conversationId }`
- GDPR: `{ contactIds: 1 }`

### `email_metadata` Collection

File: `src/channels/infrastructure/persistence/document/entities/email-metadata.schema.ts`

```typescript
{
  messageId: string;       // Links to email_contents
  tenantId: string;
  inReplyTo: string;       // Threading: parent message
  references: string[];    // Threading: full chain
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];           // BCC (outbound only, role-based access)
  bounceReason: string;    // DSN error text
  createdAt: Date;
}
```

---

## 8. Dynamic Polling Strategy

### Interval Logic (Implemented)

```typescript
getDynamicInterval(tenantId: string): number {
  // 1. Check Redis: imap:activity:{tenantId}
  //    - Recent activity (< 5 min) → ACTIVE mode
  //    - No recent activity → IDLE mode
  //
  // 2. Check BusinessHoursService (tenant timezone)
  //    - Within business hours → active/idle interval
  //    - Outside business hours → idle interval
  //
  // Returns:
  //   ACTIVE (within hours, recent activity): 2 minutes
  //   IDLE (within hours, no activity):       15 minutes
  //   OFF-HOURS:                              15 minutes
}
```

### Redis Keys

| Key                                           | Purpose                                | TTL   |
| --------------------------------------------- | -------------------------------------- | ----- |
| `imap:lock:{configId}`                        | Distributed lock (prevent double-poll) | 60s   |
| `imap:activity:{tenantId}`                    | Track recent email activity            | 5 min |
| `imap:lastpoll:{configId}`                    | Timestamp of last successful poll      | None  |
| `outbound:daily:{tenantId}:{configId}:{date}` | Daily send counter                     | 24h   |

---

## 9. GDPR & Compliance

### Multi-Party Deletion
```typescript
// When Contact A requests deletion:
await EmailContent.updateMany(
  { contactIds: 'contactA_id' },
  { $pull: { contactIds: 'contactA_id' } }
);
// When contactIds empty → delete document:
await EmailContent.deleteMany({ contactIds: { $size: 0 } });
```

### Immutable Records Policy

> **CRM is a business records system, not an email client mirror.**

If a user deletes emails on Gmail/Outlook, CRM does NOT propagate the deletion. Email records remain immutable unless:
- GDPR Data Subject Request (`$pull` on `contactIds[]`)
- Tenant Admin explicit purge via admin API
- Automated retention policy expiry

Provider-deleted emails show `[Source email deleted by user]` badge in UI.

### BCC Privacy (Role-Based Serialization)

The `bcc` field is never returned by API unless `requestingUser.id === email.senderId` OR `requestingUser.role === 'admin'`. Enforced at backend serialization layer.

---

## 10. Contact Deduplication

### Problem

Without deduplication, each inbound email from the same sender (e.g., `noreply@leapai.ai`) creates a new shadow contact, resulting in N duplicate contacts.

### Solution (Implemented in ConversationService)

```typescript
// Priority order:
// 1. Check emails[] array match
const existingByEmail = await contactsService.findByEmail(tenantId, senderEmail);

// 2. Fallback: Check omniIdentities.senderId
const existingBySender = await contactsService.findBySenderId(tenantId, senderId);

// 3. Only create new shadow contact if both return null

// 4. Atomic email update (idempotent):
await contactsService.addEmailIfMissing(contactId, senderEmail);
// Uses MongoDB $addToSet for atomic, idempotent updates
```

### Repository Method

```typescript
// ContactRepository
async addEmailIfMissing(contactId: string, email: string): Promise<void> {
  await this.model.updateOne(
    { _id: contactId },
    { $addToSet: { emails: email.toLowerCase() } }
  );
}
```

---

## 11. Frontend i18n & Dark Mode

### i18n Support

All 5 email components use `react-i18next` with the `omni` namespace:

| Component            | Key namespace       | Key count |
| -------------------- | ------------------- | --------- |
| EmailComposePanel    | `email.compose.*`   | 20 keys   |
| EmailMessageCard     | `email.message.*`   | 14 keys   |
| EmailQuotaWidget     | `email.quota.*`     | 1 key     |
| EmailSignatureEditor | `email.signature.*` | 13 keys   |
| HistoricalSyncPanel  | `email.sync.*`      | 16 keys   |

**Translation files:**
- `src/shared/i18n/locales/en/omni.json` — English
- `src/shared/i18n/locales/vi/omni.json` — Vietnamese

### Dark Mode Support

All email components implement full Tailwind `dark:` variant support:

| Light                             | Dark                                       |
| --------------------------------- | ------------------------------------------ |
| `bg-white`                        | `dark:bg-gray-800` / `dark:bg-gray-900`    |
| `bg-gray-50`                      | `dark:bg-gray-900` / `dark:bg-gray-800/50` |
| `text-gray-800`                   | `dark:text-gray-200`                       |
| `border-gray-200`                 | `dark:border-gray-700`                     |
| `hover:bg-gray-100`               | `dark:hover:bg-gray-700`                   |
| Status colors (amber, blue, etc.) | `dark:bg-{color}-900/30`                   |

**Exception:** `.email-body-content` always renders with white background + black text (like Gmail), regardless of app theme. This ensures email HTML content is always readable with original styling preserved.

### Deterministic Avatars

Replaced random `pravatar.cc` URLs with hash-based color generation:
- `getAvatarColor(name|id)` → deterministic HSL background color
- Consistent colors across sessions
- Professional appearance without external dependencies

---

## 12. Configuration Guide

### Prerequisites

1. **Redis** running (distributed locks + caching)
2. **MongoDB** running (email storage)
3. `.env` configured:
   ```env
   REDIS_HOST=localhost
   REDIS_PORT=6379
   MONGO_URI=mongodb+srv://...
   ```

### Gmail Setup

1. Enable 2-Step Verification
2. Create App Password: https://myaccount.google.com/apppasswords
3. In CRM Channel Settings:
   - SMTP Host: `smtp.gmail.com`, Port: `587`
   - IMAP Host: `imap.gmail.com`, Port: `993`
   - Email: your Gmail address
   - Password: 16-character App Password

### Outlook/Office365 Setup

1. In CRM Channel Settings:
   - SMTP Host: `smtp.office365.com`, Port: `587`
   - IMAP Host: `outlook.office365.com`, Port: `993`
   - Email: your Outlook address
   - Password: account password

### Database Migration

```bash
npx ts-node src/scripts/create-email-text-index.ts
```

### Cleanup Script (Development)

```bash
mongosh <connection_string> --eval "
  db.email_contents.deleteMany({});
  db.email_metadata.deleteMany({});
  db.omni_conversations.deleteMany({channelType: 'Email'});
  db.omni_messages.deleteMany({channelType: 'Email'});
  db.contacts.deleteMany({isShadow: true, source: 'Email'});
  print('✅ Cleaned up email sync data');
"
```

---

## 13. File Map

### Backend — New Files

| File                                                        | Purpose                                       |
| ----------------------------------------------------------- | --------------------------------------------- |
| `src/channels/adapters/smtp.adapter.ts`                     | SMTP connection verify + send                 |
| `src/channels/transport-pool.service.ts`                    | Nodemailer transport pooling                  |
| `src/channels/services/imap-poller.service.ts`              | IMAP polling engine (mailparser + Redis lock) |
| `src/channels/services/email-normalizer.service.ts`         | Auto-reply/bounce/thread classification       |
| `src/channels/services/email-normalizer.service.spec.ts`    | Unit tests for normalizer                     |
| `src/channels/services/attachment-security.service.ts`      | Extension blocklist + size filter             |
| `src/channels/services/attachment-security.service.spec.ts` | Unit tests for security                       |
| `src/channels/services/outbound-queue.service.ts`           | Throttle + daily quota                        |
| `src/channels/services/outbound-queue.service.spec.ts`      | Unit tests for queue                          |
| `src/channels/services/email-signature.service.ts`          | Signature CRUD                                |
| `src/channels/services/email-tracking.service.ts`           | Bot-resilient open tracking                   |
| `src/channels/services/email-channel-settings.service.ts`   | Channel settings management                   |
| `src/channels/services/gdpr-email.service.ts`               | GDPR multi-party deletion                     |
| `src/channels/services/historical-sync.service.ts`          | Day 1 dual-mode import                        |
| `src/channels/email-content.controller.ts`                  | REST: email content retrieval                 |
| `src/channels/email-settings.controller.ts`                 | REST: signature + settings                    |
| `src/channels/email-tracking.controller.ts`                 | Tracking pixel endpoint                       |
| `src/channels/mail-inbound/mail-inbound.module.ts`          | NestJS module wiring                          |
| `src/channels/mail-inbound/email-inbound.listener.ts`       | Event listener for inbound                    |
| `src/channels/infrastructure/.../email-content.schema.ts`   | HTML body + GDPR storage                      |
| `src/channels/infrastructure/.../email-metadata.schema.ts`  | Threading + CC/BCC + bounce                   |
| `src/scripts/create-email-text-index.ts`                    | Full-Text Search migration                    |

### Backend — Modified Files

| File                                                       | Change                                            |
| ---------------------------------------------------------- | ------------------------------------------------- |
| `src/channels/domain/channel-provider-registry.ts`         | +SMTP provider schema                             |
| `src/channels/infrastructure/.../channel-config.schema.ts` | +`'smtp'` enum                                    |
| `src/channels/adapters/adapter-registry.service.ts`        | Register SmtpAdapter                              |
| `src/channels/channels.module.ts`                          | Wire all email services + schemas                 |
| `src/omni-inbound/domain/omni-payload.ts`                  | +`'email'` ChannelType                            |
| `src/omni-inbound/services/conversation.service.ts`        | +Contact dedup (findByEmail, addEmailIfMissing)   |
| `src/contacts/contacts.service.ts`                         | +findByEmail, +findBySenderId, +addEmailIfMissing |
| `src/contacts/.../contact.repository.ts`                   | +addEmailIfMissing ($addToSet)                    |
| `src/app.module.ts`                                        | Import MailInboundModule                          |

### Frontend — New Files

| File                       | Purpose                                     |
| -------------------------- | ------------------------------------------- |
| `EmailMessageCard.tsx`     | Email-native message rendering + split view |
| `EmailComposePanel.tsx`    | TipTap WYSIWYG reply/forward composer       |
| `EmailQuotaWidget.tsx`     | Daily quota usage bar                       |
| `EmailSignatureEditor.tsx` | Rich-text signature management              |
| `HistoricalSyncPanel.tsx`  | Day 1 import UI with progress               |
| `email-styles.css`         | Email body rendering + TipTap table styles  |
| `emailApi.ts`              | Axios service for email REST endpoints      |

### Frontend — Modified Files

| File                        | Change                                                    |
| --------------------------- | --------------------------------------------------------- |
| `DynamicFormModal.tsx`      | SMTP form sections + i18n field rendering                 |
| `ChannelConfigSettings.tsx` | SMTP icon in provider list                                |
| `ChatList.tsx`              | Mail icon for email conversations + deterministic avatars |
| `ChatWindow.tsx`            | Email message rendering branch                            |
| `useOmniStore.ts`           | +`'Email'` ChannelType + emailContents cache              |
| `locales/en/omni.json`      | +64 email i18n keys                                       |
| `locales/vi/omni.json`      | +64 email i18n keys                                       |
| `locales/*/settings.json`   | +47 SMTP config i18n keys                                 |

### Dependencies

```json
{
  "nodemailer": "^6.x",
  "@types/nodemailer": "^6.x",
  "imapflow": "^1.x",
  "mailparser": "^3.x",
  "@tiptap/react": "^2.x",
  "@tiptap/starter-kit": "^2.x",
  "@tiptap/extension-table": "^2.x",
  "@tiptap/extension-underline": "^2.x",
  "@tiptap/extension-link": "^2.x",
  "@tiptap/extension-image": "^2.x",
  "dompurify": "^3.x"
}
```

---

## 14. Deferred (Future)

| Feature                               | Status   | Notes                                                                                 |
| ------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| **OAuth2 (Google/Office365)**         | Deferred | Requires OAuth consent flow + token refresh. Currently using App Password.            |
| **Webhook Push (Pub/Sub + MS Graph)** | Deferred | Currently using IMAP polling. Webhook architecture designed but not implemented.      |
| **S3/MinIO Attachment Storage**       | Deferred | Attachments currently stored as metadata references. Full S3 pipeline not yet active. |
| **Kafka Message Broker**              | Deferred | Direct IMAP polling is used. Kafka event bus designed but not implemented.            |
| **Email Templates**                   | Deferred | Requires rich text editor component — separate workstream                             |
| **DKIM/SPF Validation**               | Deferred | DNS verification flow — requires domain management UI                                 |
| **ClamAV Scanning**                   | Deferred | Extension blocklist active. Full AV scanning not yet integrated.                      |
| **Cold Storage (Atlas Tiering)**      | Deferred | Retention policies defined, cold migration not yet automated.                         |
| **Two-Way Read State Sync**           | Deferred | Optional toggle to sync CRM UI reads back to IMAP via a background worker queue.      |

---

## 15. Appendix: Devil's Advocate Rules

### A. GDPR Multi-Party Deletion
> Only the requesting contact's reference is removed from `contactIds[]`. Content persists for remaining contacts.

### B. Bounce Reason Extraction
> DSN reports parsed for human-readable error (e.g., "550 5.1.1 The email account does not exist"). Stored in `email_metadata.bounceReason`.

### C. Lazy Reply Thread-Breaking (Soft-Link)
> Reply to old/closed thread creates NEW conversation with `parentConversationId` FK. Original thread archived read-only.

### D. BCC Privacy (Role-Based Serialization)
> `bcc` field only returned when `requestingUser.id === email.senderId` OR `requestingUser.role === 'admin'`. Backend-enforced.

### E. Hidden Watermark Rejected
> `display:none; opacity:0` hidden text rejected — spam filters (Proofpoint, Mimecast) classify as phishing. Replaced by Hybrid 3-Layer Thread Correlation.

### F. Onboarding Chicken-Egg Resolved
> Dual-Mode Sync: Mode A (Contact-Enriched) for existing databases, Mode B (Auto-Discover) for empty databases with PendingContact creation.

### G. Tracking Pixel Bot Fingerprinting
> `human|bot|unknown` classification via UA + IP CIDR. UI label: "📬 Likely Opened". Opt-in only (default OFF).

### H. CID Size-Threshold Filter
> Images < 10KB → Base64 data URI. Images ≥ 10KB → S3 upload. Prevents storage bloat.

### I. Shared Inbox Assignment Lock
> `messageId` idempotency + `conversation:claim:{id}` Redis lock (30s TTL). Prevents double-response.

### J. Immutable Records — No Sync Delete
> CRM does not propagate provider-side deletions. Records immutable unless explicit GDPR/admin/retention deletion.

### K. mailparser for MIME Robustness
> Replaced raw string parsing that failed on Quoted-Printable (MailChimp, marketing emails). `simpleParser()` handles QP, Base64, multipart boundaries correctly.

### L. Contact Deduplication
> Checks `emails[]` array → `omniIdentities.senderId` → new contact creation. `$addToSet` ensures idempotent email list updates. Prevents N shadow contacts from same sender.

### M. Email CSS Preservation
> `DOMPurify.sanitize()` with `ADD_TAGS: ['style']` preserves email `<style>` blocks. Removed Tailwind `prose` class that was overriding email colors. `.email-body-content` forces white background like Gmail.

### N. Two-Way Sync / Non-Destructive Polling
> CRM does not arbitrarily mark emails as Read (`\Seen`) during IMAP polling. Users rely on the unread status in their native email clients (Gmail/Outlook) as a rudimentary to-do list. The read state is maintained locally in the CRM. Optional Two-Way Sync pushes the read state back to the provider only via explicit UI interaction, decoupled from the ingestion process.
