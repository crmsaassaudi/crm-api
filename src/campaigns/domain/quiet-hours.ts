import { BadRequestException } from '@nestjs/common';

/**
 * A local time-of-day window during which a campaign must not deliver, in the
 * campaign's own timezone — a promotional SMS at 03:00 costs a customer, and in
 * several markets a complaint.
 */
export interface QuietHours {
  /** 'HH:mm', inclusive. */
  start: string;
  /** 'HH:mm', exclusive. */
  end: string;
}

const MINUTES_PER_DAY = 1440;
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseHhMm(value: string, field: string): number {
  const match = HH_MM.exec(value);
  if (!match) {
    throw new BadRequestException(`${field} must be a time like "21:30".`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
  } catch {
    throw new BadRequestException(`"${timezone}" is not a known timezone.`);
  }
}

/**
 * The first instant at or after `from` that falls outside the quiet window.
 *
 * Used to delay the dispatch job rather than to filter recipients: a campaign
 * launched at midnight should go out in the morning, not lose its audience.
 *
 * Resolution is minutes, and the offset is applied to the UTC instant — so a
 * send that straddles a DST transition can land up to an hour off the boundary.
 * That is deliberate: the alternative is a timezone library on the hot path to
 * buy accuracy nobody can perceive in a quiet-hours rule.
 */
export function nextAllowedSendTime(
  from: Date,
  timezone: string,
  quietHours?: QuietHours | null,
): Date {
  if (!quietHours) return from;

  const start = parseHhMm(quietHours.start, 'Quiet hours start');
  const end = parseHhMm(quietHours.end, 'Quiet hours end');
  // A zero-width window is how the UI represents "no quiet hours" once a user
  // has opened the control and set both ends the same. Treating it as a 24-hour
  // block would delay the campaign forever.
  if (start === end) return from;

  const current = localMinutes(from, timezone);
  // A window that wraps midnight (22:00 → 07:00) is the common case, so it is
  // handled rather than rejected.
  const inQuietHours =
    start < end
      ? current >= start && current < end
      : current >= start || current < end;
  if (!inQuietHours) return from;

  const minutesToWait = (end - current + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return new Date(from.getTime() + minutesToWait * 60_000);
}

function localMinutes(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    // h23 rather than hour12:false — the latter renders midnight as "24" in some
    // ICU builds, which reads as the next day.
    hourCycle: 'h23',
  }).formatToParts(at);

  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(
    parts.find((part) => part.type === 'minute')?.value ?? 0,
  );
  return hour * 60 + minute;
}
