import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * LivechatWidget domain entity.
 *
 * Represents a customer-facing chat widget configuration.
 * One livechat channel can have N widgets (different branding per website).
 * Identified by a unique `widgetId` (e.g. "wdg_a1b2c3d4e5f6").
 */
export class LivechatWidget {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'wdg_a1b2c3d4e5f6' })
  widgetId: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty({ description: 'Links to ChannelConfig._id' })
  channelId: string;

  @ApiProperty({ example: 'Main Website Widget' })
  name: string;

  @ApiProperty({ enum: ['active', 'paused'], default: 'active' })
  status: string;

  // ── 1. Branding ─────────────────────────────────────────────────────────

  @ApiPropertyOptional()
  branding: {
    logo?: string;
    companyName?: string;
    agentName?: string;
    agentAvatar?: string;
    removeBranding?: boolean;
  };

  // ── 2. Theme ────────────────────────────────────────────────────────────

  @ApiPropertyOptional()
  theme: {
    primaryColor?: string;
    secondaryColor?: string;
    headerColor?: string;
    backgroundColor?: string;
    textColor?: string;
    darkMode?: 'light' | 'dark' | 'auto';
    borderRadius?: number;
    fontFamily?: string;
  };

  // ── 3. Widget Layout ────────────────────────────────────────────────────

  @ApiPropertyOptional()
  layout: {
    position?: 'bottom-right' | 'bottom-left';
    launcherType?: 'circle' | 'pill' | 'custom';
    launcherIcon?: string;
    launcherText?: string;
    launcherSize?: 'small' | 'medium' | 'large';
    widgetWidth?: number;
    widgetHeight?: number;
    offsetX?: number;
    offsetY?: number;
    hideMobile?: boolean;
    zIndex?: number;
    attentionGrabber?: {
      enabled: boolean;
      text?: string;
      delay?: number;     // seconds before showing
      hideAfter?: number; // seconds before auto-hide (0 = never)
    };
  };

  // ── 4. Welcome Experience ───────────────────────────────────────────────

  @ApiPropertyOptional()
  welcome: {
    greeting?: string;
    subtitle?: string;
    replyTimeText?: string;
    showGreetingBubble?: boolean;
    autoOpenDelay?: number;
    // State-based messages (Online/Away/Offline)
    awayGreeting?: string;
    awaySubtitle?: string;
    offlineGreeting?: string;
    offlineSubtitle?: string;
  };

  // ── 5. Conversation Starters ────────────────────────────────────────────

  @ApiPropertyOptional()
  conversationStarters: Array<{
    label: string;
    action: 'message' | 'url';
    value: string;
  }>;

  // ── 6. Offline / Business Hours ─────────────────────────────────────────

  @ApiPropertyOptional()
  offline: {
    enabled?: boolean;
    timezone?: string;
    businessHours?: Array<{
      day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
      enabled: boolean;
      start: string; // HH:mm
      end: string;   // HH:mm
    }>;
    offlineMessage?: string;
    captureLeadWhenOffline?: boolean;
  };

  // ── 7. Pre-chat Form ────────────────────────────────────────────────────

  @ApiPropertyOptional()
  preChatForm: {
    enabled?: boolean;
    showOnlyOffline?: boolean;
    fields?: Array<{
      key: string;
      label: string;
      type: 'text' | 'email' | 'tel' | 'select' | 'consent';
      placeholder?: string;
      required: boolean;
      options?: string[];
      consentText?: string;  // GDPR message (when type='consent')
      consentLink?: string;  // Privacy policy URL (when type='consent')
    }>;
  };

  // ── 8. Routing ──────────────────────────────────────────────────────────

  @ApiPropertyOptional()
  routing: {
    defaultTeamId?: string;
    routingRuleId?: string;
    roundRobin?: boolean;
    skillBased?: boolean;
    // Department selector (visitor picks before chat)
    enableDepartmentSelector?: boolean;
    departments?: Array<{ id: string; label: string }>;
    // URL-based routing rules
    urlRules?: Array<{ pattern: string; teamId: string; priority: number }>;
    // Capacity-based auto-assignment
    capacityBased?: boolean;
    maxConversationsPerAgent?: number;
    // Queue position
    showQueuePosition?: boolean;
    queueMessage?: string; // template: "You are #{position} in queue"
  };

  // ── 9. Automation ───────────────────────────────────────────────────────

  @ApiPropertyOptional()
  automation: {
    autoAssignBot?: boolean;
    botFirst?: boolean;
    aiAssistant?: boolean;
    faqSuggestions?: boolean;
  };

  // ── 10. Proactive Chat ──────────────────────────────────────────────────

  @ApiPropertyOptional()
  proactiveChat: {
    enabled?: boolean;
    rules?: Array<{
      page: string;
      delay: number;
      message: string;
      showOnce?: boolean;
      trigger?: {
        type: 'page' | 'scroll' | 'exit_intent' | 'idle' | 'visit_count';
        value?: number; // scroll %, idle seconds, visit count threshold
      };
    }>;
  };

  // ── 11. Security ────────────────────────────────────────────────────────

  @ApiPropertyOptional()
  security: {
    allowedDomains?: string[];
    identityVerification?: boolean;
    hmacSecret?: string;
  };

  // ── 12. Localization ────────────────────────────────────────────────────

  @ApiPropertyOptional()
  localization: {
    locale?: string;
    autoDetect?: boolean;
    rtl?: 'auto' | 'ltr' | 'rtl';
    translations?: Record<string, string>;
  };

  // ── 13. Advanced ────────────────────────────────────────────────────────

  @ApiPropertyOptional()
  advanced: {
    customCSS?: string;
    enableSoundNotification?: boolean;
    enableFileUpload?: boolean;
    maxFileSize?: number;
    allowedFileTypes?: string[];
    // Webhook
    webhookUrl?: string;
    webhookEvents?: string[]; // e.g. ['conversation.started', 'message.sent', 'csat.submitted']
    webhookSecret?: string;
  };

  // ── CSAT ────────────────────────────────────────────────────────────────

  @ApiPropertyOptional()
  csat: {
    enabled?: boolean;
    delay?: number;
    question?: string;         // custom question text
    thankYouMessage?: string;  // shown after submission
  };

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
