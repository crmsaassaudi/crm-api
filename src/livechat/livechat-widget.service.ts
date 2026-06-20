import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { LivechatWidgetRepository } from './infrastructure/persistence/document/repositories/livechat-widget.repository';
import { LivechatWidget } from './domain/livechat-widget';
import { randomBytes, createHmac } from 'crypto';

/**
 * Service for managing livechat widgets.
 *
 * Each widget is identified by a unique `widgetId` (prefix "wdg_").
 * The public config endpoint returns a sanitized version (no secrets).
 */
@Injectable()
export class LivechatWidgetService {
  constructor(private readonly repo: LivechatWidgetRepository) {}

  // ── Admin CRUD ───────────────────────────────────────────────────────────

  async create(
    tenantId: string,
    data: Partial<LivechatWidget>,
  ): Promise<LivechatWidget> {
    const widgetId = `wdg_${randomBytes(8).toString('hex')}`;

    // Check name uniqueness per channel
    if (data.channelId && data.name) {
      const existing = await this.repo.findByChannelId(
        tenantId,
        data.channelId,
      );
      if (existing.some((w) => w.name === data.name)) {
        throw new ConflictException(
          `Widget with name "${data.name}" already exists for this channel`,
        );
      }
    }

    return this.repo.create({
      ...data,
      widgetId,
      tenantId,
      status: 'active',
      branding: data.branding ?? {},
      theme: data.theme ?? { primaryColor: '#6366f1' },
      layout: data.layout ?? { position: 'bottom-right', launcherSize: 'medium' },
      welcome: data.welcome ?? {},
      conversationStarters: data.conversationStarters ?? [],
      offline: data.offline ?? {},
      preChatForm: data.preChatForm ?? {},
      routing: data.routing ?? {},
      automation: data.automation ?? {},
      proactiveChat: data.proactiveChat ?? { enabled: false, rules: [] },
      security: data.security ?? { allowedDomains: [] },
      localization: data.localization ?? { locale: 'en' },
      advanced: data.advanced ?? {
        enableSoundNotification: true,
        enableFileUpload: true,
        maxFileSize: 25,
      },
      csat: data.csat ?? { enabled: false },
    });
  }

  async findAll(tenantId: string): Promise<LivechatWidget[]> {
    return this.repo.findByTenantId(tenantId);
  }

  async findByChannel(
    tenantId: string,
    channelId: string,
  ): Promise<LivechatWidget[]> {
    return this.repo.findByChannelId(tenantId, channelId);
  }

  async findById(
    tenantId: string,
    id: string,
  ): Promise<LivechatWidget> {
    const widget = await this.repo.findById(tenantId, id);
    if (!widget) throw new NotFoundException('Widget not found');
    return widget;
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<LivechatWidget>,
  ): Promise<LivechatWidget> {
    // Prevent changing widgetId or tenantId
    delete (data as any).widgetId;
    delete (data as any).tenantId;

    const updated = await this.repo.update(tenantId, id, data);
    if (!updated) throw new NotFoundException('Widget not found');
    return updated;
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const deleted = await this.repo.delete(tenantId, id);
    if (!deleted) throw new NotFoundException('Widget not found');
  }

  // ── Public config (for widget JS) ────────────────────────────────────────

  /**
   * Returns the full widget configuration for the embed JS.
   * Strips sensitive fields (hmacSecret, routing internals).
   * This is called from a PUBLIC endpoint (no auth).
   */
  async getPublicConfig(
    widgetId: string,
  ): Promise<Record<string, any> | null> {
    const widget = await this.repo.findByWidgetId(widgetId);
    if (!widget || widget.status !== 'active') return null;

    // Build sanitized public config
    return {
      widgetId: widget.widgetId,
      channelId: widget.channelId,
      tenantId: widget.tenantId,

      // Branding
      branding: {
        logo: widget.branding?.logo,
        companyName: widget.branding?.companyName,
        agentName: widget.branding?.agentName,
        agentAvatar: widget.branding?.agentAvatar,
        removeBranding: widget.branding?.removeBranding ?? false,
      },

      // Theme
      theme: {
        primaryColor: widget.theme?.primaryColor ?? '#6366f1',
        secondaryColor: widget.theme?.secondaryColor,
        headerColor: widget.theme?.headerColor,
        backgroundColor: widget.theme?.backgroundColor,
        textColor: widget.theme?.textColor,
        darkMode: widget.theme?.darkMode ?? 'light',
        borderRadius: widget.theme?.borderRadius ?? 16,
        fontFamily: widget.theme?.fontFamily,
      },

      // Layout
      layout: {
        position: widget.layout?.position ?? 'bottom-right',
        launcherType: widget.layout?.launcherType ?? 'circle',
        launcherIcon: widget.layout?.launcherIcon,
        launcherSize: widget.layout?.launcherSize ?? 'medium',
        widgetWidth: widget.layout?.widgetWidth ?? 380,
        widgetHeight: widget.layout?.widgetHeight ?? 550,
        hideMobile: widget.layout?.hideMobile ?? false,
        zIndex: widget.layout?.zIndex ?? 2147483640,
      },

      // Welcome
      welcome: {
        greeting: widget.welcome?.greeting,
        subtitle: widget.welcome?.subtitle,
        replyTimeText: widget.welcome?.replyTimeText,
        showGreetingBubble: widget.welcome?.showGreetingBubble ?? false,
        autoOpenDelay: widget.welcome?.autoOpenDelay ?? 0,
      },

      // Conversation starters
      conversationStarters: widget.conversationStarters ?? [],

      // Offline / business hours
      offline: {
        enabled: widget.offline?.enabled ?? false,
        timezone: widget.offline?.timezone,
        businessHours: widget.offline?.businessHours,
        offlineMessage: widget.offline?.offlineMessage,
        captureLeadWhenOffline: widget.offline?.captureLeadWhenOffline ?? true,
      },

      // Pre-chat form
      preChatForm: {
        enabled: widget.preChatForm?.enabled ?? false,
        fields: widget.preChatForm?.fields ?? [],
      },

      // Proactive chat
      proactiveChat: {
        enabled: widget.proactiveChat?.enabled ?? false,
        rules: widget.proactiveChat?.rules ?? [],
      },

      // Localization
      localization: {
        locale: widget.localization?.locale ?? 'en',
        translations: widget.localization?.translations ?? {},
      },

      // Advanced (public subset)
      advanced: {
        customCSS: widget.advanced?.customCSS,
        enableSoundNotification:
          widget.advanced?.enableSoundNotification ?? true,
        enableFileUpload: widget.advanced?.enableFileUpload ?? true,
        maxFileSize: widget.advanced?.maxFileSize ?? 25,
        allowedFileTypes: widget.advanced?.allowedFileTypes,
      },

      // CSAT
      csat: {
        enabled: widget.csat?.enabled ?? false,
      },

      // NOTE: security.hmacSecret, routing, automation are NOT exposed.
    };
  }

  // ── Domain Whitelist ──────────────────────────────────────────────────────

  /**
   * Check if the given origin is allowed by the widget's domain whitelist.
   * Returns true if:
   *  - allowedDomains is empty/undefined (allow all)
   *  - origin matches an exact domain entry
   *  - origin matches a wildcard entry (e.g. *.example.com)
   */
  async isDomainAllowed(
    widgetId: string,
    origin: string | undefined,
  ): Promise<boolean> {
    const widget = await this.repo.findByWidgetId(widgetId);
    if (!widget || widget.status !== 'active') return false;

    const allowedDomains: string[] = widget.security?.allowedDomains ?? [];
    if (allowedDomains.length === 0) return true; // No restriction

    if (!origin) return false; // No origin header + whitelist active → block

    // Extract hostname from origin (e.g. "https://app.example.com" → "app.example.com")
    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      hostname = origin; // Fallback: treat as raw hostname
    }

    return allowedDomains.some((pattern) => {
      const p = pattern.toLowerCase().trim();
      const h = hostname.toLowerCase();
      if (p.startsWith('*.')) {
        // Wildcard: *.example.com matches sub.example.com, a.b.example.com
        const suffix = p.slice(2); // "example.com"
        return h === suffix || h.endsWith('.' + suffix);
      }
      return h === p;
    });
  }

  // ── HMAC Identity Verification ────────────────────────────────────────────

  /**
   * Verify visitor identity using HMAC-SHA256.
   * The website server generates: HMAC-SHA256(secret, identifier)
   * We re-compute and compare.
   */
  async verifyIdentity(
    widgetId: string,
    identifier: string,
    userHash: string,
  ): Promise<{ valid: boolean; required: boolean }> {
    const widget = await this.repo.findByWidgetId(widgetId);
    if (!widget) return { valid: false, required: false };

    const required = widget.security?.identityVerification === true;
    if (!required) return { valid: true, required: false };

    const secret = widget.security?.hmacSecret;
    if (!secret) return { valid: true, required: false }; // No secret configured

    if (!userHash || !identifier) return { valid: false, required: true };

    const expected = createHmac('sha256', secret)
      .update(identifier)
      .digest('hex');

    return { valid: expected === userHash, required: true };
  }

  /**
   * Regenerate HMAC secret for a widget. Returns the new secret.
   */
  async regenerateHmacSecret(
    tenantId: string,
    widgetId: string,
  ): Promise<string> {
    const widget = await this.repo.findByWidgetIdWithTenant(widgetId, tenantId);
    if (!widget) throw new NotFoundException('Widget not found');

    const newSecret = randomBytes(32).toString('hex');
    await this.repo.update(tenantId, widget.id, {
      security: {
        ...(widget.security ?? {}),
        hmacSecret: newSecret,
      },
    } as any);

    return newSecret;
  }
}
