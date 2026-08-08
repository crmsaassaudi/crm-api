import { Injectable, Logger } from '@nestjs/common';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';

/**
 * BusinessHoursService — checks whether the current time is within
 * the tenant's configured business hours.
 *
 * Used by ConversationService to decide whether to:
 *   - Send an out-of-office auto-reply
 *   - Set the conversation to 'pending' instead of 'open'
 *
 * Configuration keys:
 *   - `business_hours` — tenant schedule (from CRM settings)
 *   - `omni_session_lifecycle.oooAutoReplyEnabled` — toggle for OOO message
 *
 * Features:
 *   - Weekly schedule with configurable working hours per day
 *   - Holiday calendar support (one-off and recurring holidays)
 *   - Channel-specific OOO messages (different messages for Facebook, Zalo, etc.)
 */
@Injectable()
export class BusinessHoursService {
  private readonly logger = new Logger(BusinessHoursService.name);

  constructor(private readonly settingsService: CrmSettingsService) {}

  /**
   * Check if the current time (in the tenant's timezone) is within business hours.
   * Returns true if the tenant is currently "open for business".
   *
   * Checks (in order):
   *   1. Is today a configured holiday? → false
   *   2. Is this day of week enabled? → false if disabled
   *   3. Is current time within working hours? → true/false
   *
   * Falls back to "always open" if no schedule is configured.
   */
  async isWithinBusinessHours(tenantId: string): Promise<boolean> {
    try {
      const businessHours = await this.settingsService.getSetting(
        'business_hours',
        tenantId,
      );

      if (!businessHours) {
        return true;
      }

      const timezone = businessHours.timezone || 'UTC';
      const now = this.getNow(timezone);

      if (this.isHoliday(now, businessHours.holidays)) {
        this.logger.debug(
          `Tenant ${tenantId} is on a holiday — outside business hours`,
        );
        return false;
      }

      const daySchedule = this.getDaySchedule(now, businessHours);
      if (!daySchedule?.enabled) {
        return false;
      }

      const currentMinutes = now.getHours() * 60 + now.getMinutes();

      // Support multi-slot schedules (e.g. morning + afternoon with lunch break)
      if (daySchedule.slots && Array.isArray(daySchedule.slots)) {
        return daySchedule.slots.some(
          (slot: { start: string; end: string }) => {
            const startMinutes = this.timeToMinutes(slot.start || '09:00');
            const endMinutes = this.timeToMinutes(slot.end || '18:00');
            return (
              currentMinutes >= startMinutes && currentMinutes < endMinutes
            );
          },
        );
      }

      // Legacy: single start/end per day
      const startMinutes = this.timeToMinutes(daySchedule.start ?? '09:00');
      const endMinutes = this.timeToMinutes(daySchedule.end ?? '18:00');
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to check business hours for tenant ${tenantId}: ${errorMessage} — defaulting to open`,
      );
      return true;
    }
  }

  /**
   * Get tenant's out-of-office message configuration.
   * Supports channel-specific messages (e.g. different message for Zalo vs Facebook).
   */
  async getOOOConfig(tenantId: string): Promise<{
    oooAutoReplyEnabled: boolean;
    oooMessage: string;
    oooSetPending: boolean;
    oooChannelMessages: Record<string, string>;
  }> {
    const defaults = {
      oooAutoReplyEnabled: false,
      oooMessage:
        'Thank you for your message! Our team is currently offline. We will get back to you during business hours.',
      oooSetPending: true,
      oooChannelMessages: {} as Record<string, string>,
    };

    try {
      const config = await this.settingsService.getSetting(
        'omni_session_lifecycle',
        tenantId,
      );
      return config ? { ...defaults, ...config } : defaults;
    } catch {
      return defaults;
    }
  }

  /**
   * Get the appropriate OOO message for a specific channel.
   * Falls back to the generic oooMessage if no channel-specific message exists.
   */
  getChannelOOOMessage(
    oooConfig: {
      oooMessage: string;
      oooChannelMessages: Record<string, string>;
    },
    channelType: string,
  ): string {
    const normalizedChannel = channelType.toLowerCase();
    const channelMessage = oooConfig.oooChannelMessages?.[normalizedChannel];
    return channelMessage || oooConfig.oooMessage;
  }

  // Holiday Support

  /**
   * Check if today is a holiday.
   * Supports two formats:
   *   - Fixed date:    { date: '2026-01-01', name: 'New Year', recurring: false }
   *   - Recurring:     { date: '2026-01-01', name: 'New Year', recurring: true }
   *     (recurring = compare month-day only, ignoring year)
   */
  private isHoliday(
    now: Date,
    holidays?: Array<{
      date: string;
      name?: string;
      recurring?: boolean;
    }>,
  ): boolean {
    if (!holidays || !Array.isArray(holidays) || holidays.length === 0) {
      return false;
    }

    const todayYear = now.getFullYear();
    const todayMonth = now.getMonth() + 1; // 1-indexed
    const todayDay = now.getDate();

    return holidays.some((holiday) => {
      if (!holiday.date) return false;

      // Parse holiday date (expected format: YYYY-MM-DD)
      const parts = holiday.date.split('-');
      if (parts.length < 3) return false;

      const holidayYear = parseInt(parts[0], 10);
      const holidayMonth = parseInt(parts[1], 10);
      const holidayDay = parseInt(parts[2], 10);

      if (holiday.recurring) {
        // Recurring: only compare month and day
        return todayMonth === holidayMonth && todayDay === holidayDay;
      }

      // Fixed: compare full date
      return (
        todayYear === holidayYear &&
        todayMonth === holidayMonth &&
        todayDay === holidayDay
      );
    });
  }

  // Internals

  /**
   * Get the schedule for today, supporting both legacy and new format.
   * Legacy: { schedule: { monday: { enabled, start, end } } }
   * New:    { workingDays: [{ day: 'Monday', enabled, slots: [{ start, end }] }] }
   */
  private getDaySchedule(
    now: Date,
    businessHours: any,
  ): { enabled: boolean; start?: string; end?: string; slots?: any[] } | null {
    const dayOfWeek = this.getDayName(now);

    if (businessHours.workingDays && Array.isArray(businessHours.workingDays)) {
      const dayConfig = businessHours.workingDays.find(
        (d: any) => d.day?.toLowerCase() === dayOfWeek,
      );
      return dayConfig ?? null;
    }

    if (businessHours.schedule) {
      return businessHours.schedule[dayOfWeek] ?? null;
    }

    return null;
  }

  /**
   * The tenant's configured timezone, or UTC when none is set.
   *
   * Exposed so routing rules evaluate a time-of-day condition against the same
   * clock the schedule uses. Reading the server's local time instead made a
   * "09:00–17:00" rule mean whatever the container's TZ happened to be.
   */
  async getTenantTimezone(tenantId: string): Promise<string> {
    try {
      const businessHours = await this.settingsService.getSetting(
        'business_hours',
        tenantId,
      );
      return businessHours?.timezone || 'UTC';
    } catch {
      return 'UTC';
    }
  }

  /** Current wall-clock time in the tenant's timezone, as `HH:mm`. */
  async getTenantLocalTime(tenantId: string): Promise<string> {
    const timezone = await this.getTenantTimezone(tenantId);
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date());
    } catch {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'UTC',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date());
    }
  }

  private getNow(timezone: string): Date {
    try {
      const dateStr = new Date().toLocaleString('en-US', {
        timeZone: timezone,
      });
      return new Date(dateStr);
    } catch {
      // Invalid timezone → fall back to UTC, but say so. Silence here hid a
      // seeded default of 'ict' — not an IANA zone — which put every new
      // tenant's schedule seven hours from where its settings screen said it
      // was, with no error anywhere to connect the two.
      this.logger.warn(
        `Invalid business-hours timezone "${timezone}"; falling back to UTC. ` +
          'Set an IANA identifier such as Asia/Ho_Chi_Minh.',
      );
      return new Date();
    }
  }

  private getDayName(date: Date): string {
    const days = [
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ];
    return days[date.getDay()];
  }

  private timeToMinutes(time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    return (hours || 0) * 60 + (minutes || 0);
  }

  // SLA Business Hours Math

  /**
   * Calculate the SLA deadline accounting for business hours.
   *
   * Algorithm:
   *   Walk forward in time, only counting minutes that fall INSIDE
   *   business hours (excluding holidays and non-working days).
   *
   * Example:
   *   SLA = 2 hours, customer messages Friday 17:00, hours = 09:00–18:00
   *   → 1 hour consumed Friday (17:00–18:00)
   *   → Skip Saturday + Sunday
   *   → 1 hour consumed Monday (09:00–10:00)
   *   → Deadline = Monday 10:00
   *
   * @param tenantId        Tenant for loading business hours config
   * @param durationMinutes Total SLA budget in minutes
   * @returns The exact Date when the SLA expires (business-hours aware)
   */
  async calculateSlaDeadline(
    tenantId: string,
    durationMinutes: number,
  ): Promise<Date> {
    const businessHours = await this.settingsService.getSetting(
      'business_hours',
      tenantId,
    );

    if (!businessHours) {
      // No business hours configured → simple calendar time
      return new Date(Date.now() + durationMinutes * 60 * 1000);
    }

    const timezone = businessHours.timezone || 'UTC';
    let cursor = this.getNow(timezone);
    let remainingMinutes = durationMinutes;

    // Safety limit: don't loop for more than 365 days
    const maxIterations = 365;
    let iterations = 0;

    while (remainingMinutes > 0 && iterations < maxIterations) {
      iterations++;

      if (this.isHoliday(cursor, businessHours.holidays)) {
        cursor = this.advanceToNextDay(cursor);
        continue;
      }

      const daySchedule = this.getDaySchedule(cursor, businessHours);
      if (!daySchedule?.enabled) {
        cursor = this.advanceToNextDay(cursor);
        continue;
      }

      const { cursor: nextCursor, remainingMinutes: nextRemaining } =
        this.consumeWorkingSlots(cursor, daySchedule, remainingMinutes);

      cursor = nextCursor;
      remainingMinutes = nextRemaining;

      if (remainingMinutes > 0) {
        cursor = this.advanceToNextDay(cursor);
      }
    }

    return cursor;
  }

  /**
   * Count configured working minutes in an interval. Used when pausing an SLA
   * clock so nights, weekends and holidays already excluded from its deadline
   * are not granted a second time after resume.
   */
  async calculateBusinessMinutesBetween(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<number> {
    if (to <= from) return 0;
    const config = await this.settingsService.getSetting(
      'business_hours',
      tenantId,
    );
    if (!config) {
      return Math.ceil((to.getTime() - from.getTime()) / 60_000);
    }

    let totalMs = 0;
    let day = new Date(from);
    day.setHours(0, 0, 0, 0);
    const last = new Date(to);
    last.setHours(0, 0, 0, 0);
    let safety = 0;
    while (day <= last && safety++ < 366) {
      if (!this.isHoliday(day, config.holidays)) {
        const schedule = this.getDaySchedule(day, config);
        if (schedule?.enabled) {
          for (const slot of this.getWorkingSlots(schedule)) {
            const startMinutes = this.timeToMinutes(slot.start);
            const endMinutes = this.timeToMinutes(slot.end);
            const slotStart = new Date(day);
            slotStart.setHours(
              Math.floor(startMinutes / 60),
              startMinutes % 60,
              0,
              0,
            );
            const slotEnd = new Date(day);
            slotEnd.setHours(
              Math.floor(endMinutes / 60),
              endMinutes % 60,
              0,
              0,
            );
            const overlapStart = Math.max(from.getTime(), slotStart.getTime());
            const overlapEnd = Math.min(to.getTime(), slotEnd.getTime());
            if (overlapEnd > overlapStart) totalMs += overlapEnd - overlapStart;
          }
        }
      }
      day = this.advanceToNextDay(day);
    }
    return Math.ceil(totalMs / 60_000);
  }

  private consumeWorkingSlots(
    cursor: Date,
    daySchedule: any,
    remainingMinutes: number,
  ): { cursor: Date; remainingMinutes: number } {
    const slots = this.getWorkingSlots(daySchedule);
    const currentMinutes = cursor.getHours() * 60 + cursor.getMinutes();
    let currentRemaining = remainingMinutes;

    for (const slot of slots) {
      const slotStart = this.timeToMinutes(slot.start);
      const slotEnd = this.timeToMinutes(slot.end);

      if (currentMinutes >= slotEnd) continue;

      const effectiveStart = Math.max(currentMinutes, slotStart);
      const availableMinutes = slotEnd - effectiveStart;

      if (availableMinutes <= 0) continue;

      if (currentRemaining <= availableMinutes) {
        // SLA expires within this slot
        const deadlineMinutes = effectiveStart + currentRemaining;
        cursor.setHours(
          Math.floor(deadlineMinutes / 60),
          deadlineMinutes % 60,
          0,
          0,
        );
        return { cursor, remainingMinutes: 0 };
      }

      currentRemaining -= availableMinutes;
    }

    return { cursor, remainingMinutes: currentRemaining };
  }

  private getWorkingSlots(
    daySchedule: any,
  ): Array<{ start: string; end: string }> {
    if (daySchedule.slots && Array.isArray(daySchedule.slots)) {
      return daySchedule.slots;
    }
    // Legacy format
    return [
      {
        start: daySchedule.start || '09:00',
        end: daySchedule.end || '18:00',
      },
    ];
  }

  private advanceToNextDay(date: Date): Date {
    const next = new Date(date);
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 0, 0);
    return next;
  }
}
