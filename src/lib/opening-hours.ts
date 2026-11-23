import type { Company } from '../shared/types';
import { toMinute } from '../shared/hours';

// The Settings form's opening hours. Orderly stores "open 24 hours" as the same opening and closing
// time, which an owner can also type by mistake (11 AM picked for 11 PM), so the form asks for it by
// name and refuses two equal times without it.

type Hours = Company['openingHours'];

export const isAllDay = (hours: Pick<Hours, 'start' | 'end'>) => hours.start === hours.end;

export const SAME_TIMES =
  'The opening and closing times are the same. Choose a different closing time, or turn on Open 24 hours.';

/** Why these times can't be saved, or ''. */
export const hoursProblem = (hours: Pick<Hours, 'start' | 'end'>, allDay: boolean) =>
  !allDay && isAllDay(hours) ? SAME_TIMES : '';

/** The hours as saved: 24 hours is always 00:00–00:00, whatever times were left in the form. */
export const savedHours = (hours: Hours, allDay: boolean): Hours =>
  allDay ? { ...hours, start: '00:00', end: '00:00' } : hours;

/** "15:00" as "3:00 PM", with the two a 12-hour picker mixes up in words. */
export function clockWords(time: string): string {
  const minute = toMinute(time);
  if (!Number.isFinite(minute)) return time;
  const hour = Math.floor(minute / 60);
  const words = `${hour % 12 || 12}:${String(minute % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
  return minute === 0 ? `${words} (midnight)` : minute === 720 ? `${words} (noon)` : words;
}

/** "Open 3:00 PM to 3:00 AM the next day (12 hours).", or '' for times not filled in. */
export function hoursSummary(hours: Pick<Hours, 'start' | 'end'>, allDay: boolean): string {
  if (allDay) return 'Open 24 hours on the days you choose.';
  const start = toMinute(hours.start),
    end = toMinute(hours.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return '';
  const minutes = (end - start + 1440) % 1440;
  const whole = Math.floor(minutes / 60),
    rest = minutes % 60;
  const length = [
    whole ? `${whole} hour${whole === 1 ? '' : 's'}` : '',
    rest ? `${rest} minute${rest === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `Open ${clockWords(hours.start)} to ${clockWords(hours.end)}${
    start > end ? ' the next day' : ''
  } (${length}). The bot takes orders only in these hours.`;
}
