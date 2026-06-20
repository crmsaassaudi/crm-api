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
    launcherSize?: 'small' | 'medium' | 'large';
    widgetWidth?: number;
    widgetHeight?: number;
    hideMobile?: boolean;
    zIndex?: number;
  };

  // ── 4. Welcome Experience ───────────────────────────────────────────────

  @ApiPropertyOptional()
  welcome: {
    greeting?: string;
    subtitle?: string;
    replyTimeText?: string;
    showGreetingBubble?: boolean;
    autoOpenDelay?: number;
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
    businessHours?: Record<string, any>;
    offlineMessage?: string;
    captureLeadWhenOffline?: boolean;
  };

  // ── 7. Pre-chat Form ────────────────────────────────────────────────────

  @ApiPropertyOptional()
  preChatForm: {
    enabled?: boolean;
    fields?: Array<{
      key: string;
      label: string;
      type: 'text' | 'email' | 'tel' | 'select';
      required: boolean;
      options?: string[];
    }>;
  };

  // ── 8. Routing ──────────────────────────────────────────────────────────

  @ApiPropertyOptional()
  routing: {
    defaultTeamId?: string;
    routingRuleId?: string;
    roundRobin?: boolean;
    skillBased?: boolean;
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
  };

  // ── CSAT ────────────────────────────────────────────────────────────────

  @ApiPropertyOptional()
  csat: {
    enabled?: boolean;
    delay?: number;
  };

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
