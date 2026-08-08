import { BadRequestException } from '@nestjs/common';
import {
  assertValidTimezone,
  nextAllowedSendTime,
  parseHhMm,
} from './quiet-hours';

/** 2026-08-07T22:30:00Z â€” 01:30 the next day in Riyadh (UTC+3). */
const AT_2230_UTC = new Date('2026-08-07T22:30:00.000Z');
/** 2026-08-07T09:00:00Z â€” 12:00 in Riyadh. */
const AT_0900_UTC = new Date('2026-08-07T09:00:00.000Z');

describe('parseHhMm', () => {
  it('should accept a 24-hour time', () => {
    expect(parseHhMm('21:30', 'x')).toBe(21 * 60 + 30);
    expect(parseHhMm('00:00', 'x')).toBe(0);
  });

  it.each(['24:00', '7:00', '21:60', 'evening', ''])(
    'should reject %p',
    (value) => {
      expect(() => parseHhMm(value, 'Quiet hours start')).toThrow(
        BadRequestException,
      );
    },
  );
});

describe('assertValidTimezone', () => {
  it('should accept an IANA zone', () => {
    expect(() => assertValidTimezone('Asia/Riyadh')).not.toThrow();
  });

  it('should reject anything else', () => {
    expect(() => assertValidTimezone('Mars/Olympus')).toThrow(
      BadRequestException,
    );
  });
});

describe('nextAllowedSendTime', () => {
  it('should return the instant unchanged when there are no quiet hours', () => {
    expect(nextAllowedSendTime(AT_2230_UTC, 'Asia/Riyadh', null)).toBe(
      AT_2230_UTC,
    );
  });

  it('should return the instant unchanged when outside the window', () => {
    // 12:00 Riyadh, window 21:00â€“08:00.
    const result = nextAllowedSendTime(AT_0900_UTC, 'Asia/Riyadh', {
      start: '21:00',
      end: '08:00',
    });
    expect(result).toBe(AT_0900_UTC);
  });

  /**
   * The common case: a window that wraps midnight. Handling it as `start < end`
   * would decide 01:30 is outside 21:00â€“08:00 and send at two in the morning.
   */
  it('should wait until the window ends when inside a window that wraps midnight', () => {
    // 01:30 Riyadh, window 21:00â€“08:00 â†’ 6h30m to wait.
    const result = nextAllowedSendTime(AT_2230_UTC, 'Asia/Riyadh', {
      start: '21:00',
      end: '08:00',
    });
    expect(result.getTime() - AT_2230_UTC.getTime()).toBe(6.5 * 60 * 60 * 1000);
  });

  it('should handle a window inside one day', () => {
    // 12:00 Riyadh, window 09:00â€“14:00 â†’ 2h to wait.
    const result = nextAllowedSendTime(AT_0900_UTC, 'Asia/Riyadh', {
      start: '09:00',
      end: '14:00',
    });
    expect(result.getTime() - AT_0900_UTC.getTime()).toBe(2 * 60 * 60 * 1000);
  });

  it('should read the clock in the campaign timezone, not the server one', () => {
    // The same instant is 01:30 in Riyadh but 22:30 in UTC. With a 21:00â€“08:00
    // window both are inside it, but the wait differs â€” which is the proof the
    // zone is actually being applied.
    const riyadh = nextAllowedSendTime(AT_2230_UTC, 'Asia/Riyadh', {
      start: '21:00',
      end: '08:00',
    });
    const utc = nextAllowedSendTime(AT_2230_UTC, 'UTC', {
      start: '21:00',
      end: '08:00',
    });
    expect(riyadh.getTime()).not.toBe(utc.getTime());
    expect(utc.getTime() - AT_2230_UTC.getTime()).toBe(9.5 * 60 * 60 * 1000);
  });

  /**
   * A zero-width window is how the UI represents "quiet hours off" once someone
   * has opened the control. Treating it as a 24-hour block would delay the
   * campaign forever.
   */
  it('should treat a zero-width window as no quiet hours', () => {
    const result = nextAllowedSendTime(AT_2230_UTC, 'UTC', {
      start: '08:00',
      end: '08:00',
    });
    expect(result).toBe(AT_2230_UTC);
  });
});
