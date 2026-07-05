import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
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
  private readonly logger = new Logger(LivechatWidgetService.name);

  // ── PERF FIX #2: In-memory TTL cache for widget lookups ────────────────
  // Widget configs are written rarely (admin updates) but read on every
  // visitor socket connect + config request. Cache eliminates ~5-15ms
  // DB hit per read. TTL = 5 min, invalidated on update/delete.
  private readonly widgetCache = new Map<
    string,
    { widget: LivechatWidget | null; expiresAt: number }
  >();
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private readonly repo: LivechatWidgetRepository) {}

  // ── Admin CRUD ───────────────────────────────────────────────────────────

  async create(
    tenantId: string,
    data: Partial<LivechatWidget>,
  ): Promise<LivechatWidget> {
    const widgetId = `wdg_${randomBytes(8).toString('hex')}`;

    await this.ensureUniqueName(tenantId, data.channelId, data.name);

    const widgetData = {
      ...data,
      ...this.applyDefaultSettings(data),
      widgetId,
      tenantId,
      status: 'active',
    };

    return this.repo.create(widgetData as LivechatWidget);
  }

  private async ensureUniqueName(
    tenantId: string,
    channelId?: string,
    name?: string,
  ): Promise<void> {
    if (!channelId || !name) return;

    const existing = await this.repo.findByChannelId(tenantId, channelId);
    if (existing.some((w) => w.name === name)) {
      throw new ConflictException(
        `Widget with name "${name}" already exists for this channel`,
      );
    }
  }

  private applyDefaultSettings(
    data: Partial<LivechatWidget>,
  ): Partial<LivechatWidget> {
    return {
      branding: data.branding ?? {},
      theme: data.theme ?? { primaryColor: '#6366f1' },
      layout: data.layout ?? {
        position: 'bottom-right',
        launcherSize: 'medium',
        offsetX: 20,
        offsetY: 20,
      },
      welcome: data.welcome ?? {},
      conversationStarters: data.conversationStarters ?? [],
      offline: data.offline ?? {},
      preChatForm: data.preChatForm ?? {
        trigger: 'before_chat',
        skipIfKnownVisitor: false,
      },
      routing: data.routing ?? {},
      automation: data.automation ?? {},
      proactiveChat: data.proactiveChat ?? { enabled: false, rules: [] },
      security: data.security ?? { allowedDomains: [] },
      localization: data.localization ?? {
        locale: 'en',
        autoDetect: true,
        fallbackLocale: 'en',
      },
      advanced: data.advanced ?? {
        enableSoundNotification: true,
        enableFileUpload: true,
        maxFileSize: 25,
        imagePreview: true,
        dragDrop: false,
        cameraCapture: false,
        maxFilesPerMessage: 1,
      },
      csat: data.csat ?? { enabled: false },
      mobile: data.mobile ?? {
        enabled: true,
        fullscreen: false,
        launcherBottomOffset: 16,
      },
      displayRules: data.displayRules ?? {},
      launcher: data.launcher ?? {
        showUnreadBadge: true,
        pulseAnimation: false,
      },
      notifications: data.notifications ?? { sound: true, vibration: false },
      statePersistence: data.statePersistence ?? {
        rememberOpenState: false,
        rememberDraftMessage: true,
      },
    };
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

  async findById(tenantId: string, id: string): Promise<LivechatWidget> {
    const widget = await this.repo.findById(tenantId, id);
    if (!widget) throw new NotFoundException('Widget not found');
    return widget;
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<LivechatWidget>,
  ): Promise<LivechatWidget> {
    const sanitized = data as Record<string, unknown>;
    delete sanitized.widgetId;
    delete sanitized.tenantId;

    const updated = await this.repo.update(tenantId, id, data);
    if (!updated) throw new NotFoundException('Widget not found');

    // PERF FIX #2: Invalidate cache on update
    if (updated.widgetId) this.widgetCache.delete(updated.widgetId);

    return updated;
  }

  async delete(tenantId: string, id: string): Promise<void> {
    // Pre-load to get widgetId for cache invalidation
    const widget = await this.repo.findById(tenantId, id);
    const deleted = await this.repo.delete(tenantId, id);
    if (!deleted) throw new NotFoundException('Widget not found');

    // PERF FIX #2: Invalidate cache on delete
    if (widget?.widgetId) this.widgetCache.delete(widget.widgetId);
  }

  // ── Public config (for widget JS) ────────────────────────────────────────

  /**
   * Returns the full widget configuration for the embed JS.
   * Strips sensitive fields (hmacSecret, routing internals).
   * This is called from a PUBLIC endpoint (no auth).
   * Uses cached widget lookup (PERF FIX #2).
   */
  async getPublicConfig(widgetId: string): Promise<Record<string, any> | null> {
    const widget = await this.getCachedWidget(widgetId);
    if (!widget || widget.status !== 'active') return null;

    return this.buildPublicConfig(widget);
  }

  /** Build sanitized public config from a pre-loaded widget entity. */
  private buildPublicConfig(widget: LivechatWidget): Record<string, any> {
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
        launcherText: widget.layout?.launcherText,
        launcherSize: widget.layout?.launcherSize ?? 'medium',
        widgetWidth: widget.layout?.widgetWidth ?? 380,
        widgetHeight: widget.layout?.widgetHeight ?? 550,
        offsetX: widget.layout?.offsetX ?? 20,
        offsetY: widget.layout?.offsetY ?? 20,
        hideMobile: widget.layout?.hideMobile ?? false,
        zIndex: widget.layout?.zIndex ?? 2147483640,
        attentionGrabber: widget.layout?.attentionGrabber,
      },

      // Welcome
      welcome: {
        greeting: widget.welcome?.greeting,
        subtitle: widget.welcome?.subtitle,
        replyTimeText: widget.welcome?.replyTimeText,
        showGreetingBubble: widget.welcome?.showGreetingBubble ?? false,
        autoOpenDelay: widget.welcome?.autoOpenDelay ?? 0,
        awayGreeting: widget.welcome?.awayGreeting,
        awaySubtitle: widget.welcome?.awaySubtitle,
        offlineGreeting: widget.welcome?.offlineGreeting,
        offlineSubtitle: widget.welcome?.offlineSubtitle,
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
        trigger: widget.preChatForm?.trigger ?? 'before_chat',
        skipIfKnownVisitor: widget.preChatForm?.skipIfKnownVisitor ?? false,
        showOnlyOffline: widget.preChatForm?.showOnlyOffline ?? false,
        fields: widget.preChatForm?.fields ?? [],
      },

      // Routing (public subset — department selector only)
      routing: {
        enableDepartmentSelector:
          widget.routing?.enableDepartmentSelector ?? false,
        departments: widget.routing?.departments ?? [],
        showQueuePosition: widget.routing?.showQueuePosition ?? false,
        queueMessage:
          widget.routing?.queueMessage ?? 'You are #{position} in queue',
      },

      // Proactive chat
      proactiveChat: {
        enabled: widget.proactiveChat?.enabled ?? false,
        rules: widget.proactiveChat?.rules ?? [],
      },

      // Localization
      localization: {
        locale: widget.localization?.locale ?? 'en',
        autoDetect: widget.localization?.autoDetect ?? true,
        fallbackLocale: widget.localization?.fallbackLocale ?? 'en',
        supportedLocales: widget.localization?.supportedLocales ?? [],
        rtl: this.resolveRtlDirection(widget.localization),
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
        imagePreview: widget.advanced?.imagePreview ?? true,
        dragDrop: widget.advanced?.dragDrop ?? false,
        cameraCapture: widget.advanced?.cameraCapture ?? false,
        maxFilesPerMessage: widget.advanced?.maxFilesPerMessage ?? 1,
      },

      // CSAT
      csat: {
        enabled: widget.csat?.enabled ?? false,
        question: widget.csat?.question,
        thankYouMessage: widget.csat?.thankYouMessage,
      },

      // Mobile behavior
      mobile: {
        enabled: widget.mobile?.enabled ?? true,
        fullscreen: widget.mobile?.fullscreen ?? false,
        launcherBottomOffset: widget.mobile?.launcherBottomOffset ?? 16,
      },

      // Display rules (client-side targeting)
      displayRules: {
        includePages: widget.displayRules?.includePages ?? [],
        excludePages: widget.displayRules?.excludePages ?? [],
        devices: widget.displayRules?.devices ?? [
          'desktop',
          'mobile',
          'tablet',
        ],
        loggedInOnly: widget.displayRules?.loggedInOnly ?? false,
      },

      // Launcher customisation
      launcher: {
        label: widget.launcher?.label,
        showUnreadBadge: widget.launcher?.showUnreadBadge ?? true,
        pulseAnimation: widget.launcher?.pulseAnimation ?? false,
      },

      // Notifications (sound migrated from advanced; browser push is Phase 2)
      notifications: {
        sound:
          widget.notifications?.sound ??
          widget.advanced?.enableSoundNotification ??
          true,
        vibration: widget.notifications?.vibration ?? false,
      },

      // State persistence
      statePersistence: {
        rememberOpenState: widget.statePersistence?.rememberOpenState ?? false,
        rememberDraftMessage:
          widget.statePersistence?.rememberDraftMessage ?? true,
      },

      // NOTE: security.hmacSecret, routing internals, automation are NOT exposed.
    };
  }

  /** Resolve the RTL text direction from locale settings. */
  private resolveRtlDirection(localization?: {
    rtl?: string;
    locale?: string;
  }): string {
    const rtlSetting = localization?.rtl ?? 'auto';
    if (rtlSetting !== 'auto') return rtlSetting;
    const RTL_LOCALES = ['ar', 'he', 'fa', 'ur'];
    return RTL_LOCALES.includes(localization?.locale ?? 'en') ? 'rtl' : 'ltr';
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
    const widget = await this.getCachedWidget(widgetId);
    return this.checkDomainAllowed(widget, origin);
  }

  /**
   * PERF FIX #8: Combined domain check + config generation with single DB load.
   * Used by getWidgetConfig endpoint which previously did 2 separate DB queries.
   */
  async getDomainCheckAndConfig(
    widgetId: string,
    origin: string | undefined,
  ): Promise<{ allowed: boolean; config: Record<string, any> | null }> {
    const widget = await this.getCachedWidget(widgetId);
    const allowed = this.checkDomainAllowed(widget, origin);
    if (!allowed) return { allowed: false, config: null };

    if (!widget || widget.status !== 'active') {
      return { allowed: true, config: null };
    }

    const config = this.buildPublicConfig(widget);
    return { allowed: true, config };
  }

  /**
   * Domain whitelist check against a preloaded widget entity.
   */
  private checkDomainAllowed(
    widget: LivechatWidget | null,
    origin: string | undefined,
  ): boolean {
    if (!widget || widget.status !== 'active') return false;

    const allowedDomains: string[] = widget.security?.allowedDomains ?? [];
    if (allowedDomains.length === 0) return true;

    if (!origin) return false;

    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      hostname = origin;
    }

    return allowedDomains.some((pattern) => {
      const p = pattern.toLowerCase().trim();
      const h = hostname.toLowerCase();
      if (p.startsWith('*.')) {
        const suffix = p.slice(2);
        return h === suffix || h.endsWith('.' + suffix);
      }
      return h === p;
    });
  }

  /**
   * PERF FIX #2: Cached widget lookup with TTL.
   * Widget configs change rarely — caching saves a DB query on every
   * socket connect and config request.
   */
  async getCachedWidget(widgetId: string): Promise<LivechatWidget | null> {
    const cached = this.widgetCache.get(widgetId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.widget;
    }

    const widget = await this.repo.findByWidgetId(widgetId);
    this.widgetCache.set(widgetId, {
      widget,
      expiresAt: Date.now() + LivechatWidgetService.CACHE_TTL_MS,
    });
    return widget;
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
    const widget = await this.getCachedWidget(widgetId);
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
    } as Partial<LivechatWidget>);

    return newSecret;
  }
}
