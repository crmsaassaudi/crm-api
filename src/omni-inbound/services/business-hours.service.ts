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
        // No business hours configured → treat as always open
        return true;
      }

      const timezone = businessHours.timezone || 'UTC';
      const now = this.getNow(timezone);

      // ── Holiday check ──────────────────────────────────────────────
      if (this.isHoliday(now, businessHours.holidays)) {
        this.logger.debug(
          `Tenant ${tenantId} is on a holiday — outside business hours`,
        );
        return false;
      }

      // ── Weekly schedule check ──────────────────────────────────────
      // Support both legacy format (schedule.{dayName}) and new format (workingDays[])
      const daySchedule = this.getDaySchedule(now, businessHours);
      if (!daySchedule || !daySchedule.enabled) {
        // This day is not a working day
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
      const startMinutes = this.timeToMinutes(daySchedule.start || '09:00');
      const endMinutes = this.timeToMinutes(daySchedule.end || '18:00');
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } catch (err) {
      this.logger.warn(
        `Failed to check business hours for tenant ${tenantId}: ${err.message} — defaulting to open`,
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

  // ────────────────────────────────────────────────────────────────────────
  // Holiday Support
  // ────────────────────────────────────────────────────────────────────────

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

  // ────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────

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

    // New format: workingDays array
    if (businessHours.workingDays && Array.isArray(businessHours.workingDays)) {
      const dayConfig = businessHours.workingDays.find(
        (d: any) => d.day?.toLowerCase() === dayOfWeek,
      );
      return dayConfig ?? null;
    }

    // Legacy format: schedule object keyed by day name
    if (businessHours.schedule) {
      return businessHours.schedule[dayOfWeek] ?? null;
    }

    return null;
  }

  /**
   * Get the current date/time in a specific timezone.
   */
  private getNow(timezone: string): Date {
    try {
      const dateStr = new Date().toLocaleString('en-US', {
        timeZone: timezone,
      });
      return new Date(dateStr);
    } catch {
      // Invalid timezone → fallback to UTC
      return new Date();
    }
  }

  /**
   * Get the lowercase day name for a Date.
   */
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

  /**
   * Convert a "HH:MM" string to minutes since midnight.
   */
  private timeToMinutes(time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    return (hours || 0) * 60 + (minutes || 0);
  }

  // ────────────────────────────────────────────────────────────────────────
  // SLA Business Hours Math
  // ────────────────────────────────────────────────────────────────────────

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

      // Skip holidays
      if (this.isHoliday(cursor, businessHours.holidays)) {
        cursor = this.advanceToNextDay(cursor);
        continue;
      }

      // Get today's schedule
      const daySchedule = this.getDaySchedule(cursor, businessHours);
      if (!daySchedule || !daySchedule.enabled) {
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
   * Consume available minutes in today's working slots.
   */
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

      // Skip slots that have already passed
      if (currentMinutes >= slotEnd) continue;

      // Calculate effective start (either now or slot start, whichever is later)
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

      // Consume all available minutes in this slot
      currentRemaining -= availableMinutes;
    }

    return { cursor, remainingMinutes: currentRemaining };
  }

  /**
   * Get normalized working slots from a day schedule.
   */
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

  /**
   * Advance cursor to the start of the next day (00:00).
   */
  private advanceToNextDay(date: Date): Date {
    const next = new Date(date);
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 0, 0);
    return next;
  }
}
