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
 */
@Injectable()
export class BusinessHoursService {
  private readonly logger = new Logger(BusinessHoursService.name);

  constructor(private readonly settingsService: CrmSettingsService) {}

  /**
   * Check if the current time (in the tenant's timezone) is within business hours.
   * Returns true if the tenant is currently "open for business".
   *
   * Falls back to "always open" if no schedule is configured.
   */
  async isWithinBusinessHours(tenantId: string): Promise<boolean> {
    try {
      const businessHours = await this.settingsService.getSetting(
        'business_hours',
        tenantId,
      );

      if (!businessHours || !businessHours.schedule) {
        // No business hours configured → treat as always open
        return true;
      }

      const timezone = businessHours.timezone || 'UTC';
      const now = this.getNow(timezone);
      const dayOfWeek = this.getDayName(now);

      const daySchedule = businessHours.schedule[dayOfWeek];
      if (!daySchedule || !daySchedule.enabled) {
        // This day is not a working day
        return false;
      }

      const currentMinutes = now.getHours() * 60 + now.getMinutes();
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
   */
  async getOOOConfig(tenantId: string): Promise<{
    oooAutoReplyEnabled: boolean;
    oooMessage: string;
    oooSetPending: boolean;
  }> {
    const defaults = {
      oooAutoReplyEnabled: false,
      oooMessage:
        'Thank you for your message! Our team is currently offline. We will get back to you during business hours.',
      oooSetPending: true,
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
}
