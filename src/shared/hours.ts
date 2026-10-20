import type { DealSchedule, TurnInput } from './types';

// Local time in a restaurant's timezone and the one window rule that opening hours and deal
// times share. Used by the engine, the server, the menu page and the dashboard, so it imports
// nothing but types and stays light.

/** A local moment: weekday (0 = Sunday), minute of the day and date 'YYYY-MM-DD'. */
export type Clock = { day: number; minute: number; date: string };
/** Days plus a start and end time, as opening hours and deal schedules store them. */
export type Window = Pick<DealSchedule, 'days' | 'start' | 'end'>;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
// One formatter per timezone: building one is slow on old phones, and every deal needs a clock.
const formatters = new Map<string, Intl.DateTimeFormat>();

/** The local clock at `nowIso`, or undefined for a bad date or zone (callers fail closed). */
export function localClock(timezone: string, nowIso: string): Clock | undefined {
  const at = new Date(nowIso);
  if (!Number.isFinite(at.getTime())) return undefined;
  try {
    let format = formatters.get(timezone);
    if (!format) {
      format = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
      formatters.set(timezone, format);
    }
    const parts = format.formatToParts(at);
    const part = (key: string) => parts.find((p) => p.type === key)?.value ?? '';
    const day = WEEKDAYS.indexOf(part('weekday'));
    // Some engines write midnight as hour 24.
    const minute = (Number(part('hour')) % 24) * 60 + Number(part('minute'));
    const date = `${part('year')}-${part('month')}-${part('day')}`;
    return day < 0 || !Number.isFinite(minute) || !DATE_RE.test(date)
      ? undefined
      : { day, minute, date };
  } catch {
    return undefined;
  }
}

/** 'HH:MM' as minutes after midnight, or NaN. */
export const toMinute = (time: string) => {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return NaN;
  const [h, m] = time.split(':').map(Number);
  return h! * 60 + m!;
};

/** 'YYYY-MM-DD' moved by n days (calendar days: no timezone or daylight saving involved). */
export function addDays(date: string, n: number): string {
  const at = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(at) ? new Date(at + n * DAY_MS).toISOString().slice(0, 10) : date;
}
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/**
 * The window rule as a test, with the times read once (for checking many clocks). start === end
 * is all day on listed days; start < end is start up to (not including) end; start > end
 * crosses midnight, and its after-midnight part belongs to the day before.
 */
export function windowTest(window: Window): (clock: Pick<Clock, 'day' | 'minute'>) => boolean {
  const start = toMinute(window.start),
    end = toMinute(window.end);
  const listed = (day: number) => window.days.includes(day);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return () => false;
  if (start === end) return ({ day }) => listed(day);
  if (start < end) return ({ day, minute }) => listed(day) && minute >= start && minute < end;
  return ({ day, minute }) =>
    (minute >= start && listed(day)) || (minute < end && listed((day + 6) % 7));
}
/** Whether a clock is inside a window: exactly the opening-hours rule (isOpen). */
export const inWindow = (window: Window, clock: Pick<Clock, 'day' | 'minute'>) =>
  windowTest(window)(clock);

/**
 * A window wholly after midnight, such as 00:00–03:00. Owners mean the PREVIOUS evening's
 * night ("Friday raat 12 se 3"), so it is worded and dated as that night.
 */
export function isNightWindow(window: Pick<Window, 'start' | 'end'>): boolean {
  const start = toMinute(window.start),
    end = toMinute(window.end);
  return start < end && end <= 6 * 60;
}

/** The date the window occurrence at this clock belongs to, or undefined outside the window. */
export function occurrenceDate(schedule: Window, clock: Clock): string | undefined {
  if (!inWindow(schedule, clock)) return undefined;
  const start = toMinute(schedule.start),
    end = toMinute(schedule.end);
  if (start === end) return clock.date;
  if (start < end) return isNightWindow(schedule) ? addDays(clock.date, -1) : clock.date;
  return clock.minute >= start ? clock.date : addDays(clock.date, -1);
}

/** Whether a deal's times allow it now. No schedule: always. No clock: never (fail closed). */
export function dealOpenAt(schedule: DealSchedule | undefined, clock: Clock | undefined): boolean {
  if (!schedule) return true;
  if (!clock) return false;
  const date = occurrenceDate(schedule, clock);
  return (
    date !== undefined &&
    (!schedule.startDate || date >= schedule.startDate) &&
    (!schedule.endDate || date <= schedule.endDate)
  );
}

/**
 * Still before the start date, judged as dealOpenAt judges it: inside a window by the date the
 * occurrence belongs to (after midnight, a night is still the evening before), otherwise by
 * today's date. So "from 2 Mar" stays in the wording for as long as the deal is held back by it.
 */
export function beforeStartDate(
  schedule: Pick<DealSchedule, 'days' | 'start' | 'end' | 'startDate'>,
  clock: Clock,
): boolean {
  return (
    !!schedule.startDate && (occurrenceDate(schedule, clock) ?? clock.date) < schedule.startDate
  );
}

/**
 * The date of the last occurrence between the schedule's dates (searching back at most 6 days
 * from the end date), or undefined with no end date or no occurrence.
 */
export function lastOccurrence(schedule: DealSchedule): string | undefined {
  const { startDate, endDate } = schedule;
  if (!endDate || !DATE_RE.test(endDate) || !Number.isFinite(Date.parse(endDate))) return undefined;
  // A night window's listed day is the calendar day after the evening it is dated by.
  const shift = isNightWindow(schedule) ? 1 : 0;
  for (let back = 0; back < 7; back++) {
    const date = addDays(endDate, -back);
    if (startDate && date < startDate) return undefined;
    if (schedule.days.includes((weekdayOf(date) + shift) % 7)) return date;
  }
  return undefined;
}

/** The local moment after which the deal can never be on again, or undefined. */
export function dealEndsAt(schedule: DealSchedule): { date: string; minute: number } | undefined {
  const last = lastOccurrence(schedule);
  if (!last) return undefined;
  const start = toMinute(schedule.start),
    end = toMinute(schedule.end);
  if (start === end) return { date: addDays(last, 1), minute: 0 };
  if (start < end && !isNightWindow(schedule)) return { date: last, minute: end };
  return { date: addDays(last, 1), minute: end };
}

/** Past the end of its last occurrence. A dated schedule with no occurrence left has ended. */
export function dealEnded(schedule: DealSchedule | undefined, clock: Clock | undefined): boolean {
  if (!schedule?.endDate || !clock) return false;
  const ends = dealEndsAt(schedule);
  if (!ends) return true;
  return clock.date > ends.date || (clock.date === ends.date && clock.minute >= ends.minute);
}

/** No listed weekday falls between the start and end dates, so the deal could never be on. */
export function scheduleNeverOccurs(schedule: DealSchedule): boolean {
  if (!schedule.days.some((day) => Number.isInteger(day) && day >= 0 && day <= 6)) return true;
  return !!schedule.endDate && !lastOccurrence(schedule);
}

/**
 * The moment a turn is judged at: when a late message was really processed (receivedAt),
 * otherwise its own time. The engine and the service share it so they never disagree.
 */
export const turnInstant = (input: Pick<TurnInput, 'now' | 'receivedAt'>) =>
  input.receivedAt && Number.isFinite(Date.parse(input.receivedAt)) ? input.receivedAt : input.now;
