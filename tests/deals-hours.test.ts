import { describe, expect, it } from 'vitest';
import { closedText, isOpen } from '../src/domain/engine';
import {
  addDays,
  dealEnded,
  dealEndsAt,
  dealOpenAt,
  inWindow,
  isNightWindow,
  lastOccurrence,
  localClock,
  occurrenceDate,
  scheduleNeverOccurs,
  toMinute,
  turnInstant,
} from '../src/shared/hours';
import { seedCompanies } from '../src/shared/seed';
import type { Company, DealSchedule } from '../src/shared/types';

const company = seedCompanies[0]!;
const PKT = 'Asia/Karachi';
const LONDON = 'Europe/London';
const everyDay = [0, 1, 2, 3, 4, 5, 6];
// A Karachi wall-clock time ('2026-08-15T01:00') as the instant it is.
const pkt = (local: string) => new Date(`${local}:00+05:00`).toISOString();
const at = (local: string) => localClock(PKT, pkt(local));
// What a deal's times make it at that moment, in dealState's order (ended before later).
const status = (schedule: DealSchedule, clock = at('2026-08-14T13:00')) =>
  dealEnded(schedule, clock) ? 'ended' : dealOpenAt(schedule, clock) ? 'on' : 'later';

// isOpen and its clock as they were before shared/hours.ts, to prove the rebuilt ones agree.
function clockBefore(timezone: string, now: string) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return undefined;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const part = (key: string) => parts.find((p) => p.type === key)?.value ?? '';
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday'));
    const minute = Number(part('hour')) * 60 + Number(part('minute'));
    return day < 0 || !Number.isFinite(minute) ? undefined : { day, minute };
  } catch {
    return undefined;
  }
}
function isOpenBefore(restaurant: Company, now: string): boolean {
  try {
    const clock = clockBefore(restaurant.timezone, now);
    if (!clock) return false;
    const { day, minute } = clock;
    const start = toMinute(restaurant.openingHours.start),
      end = toMinute(restaurant.openingHours.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    const days = restaurant.openingHours.days;
    if (start === end) return days.includes(day);
    if (start < end) return days.includes(day) && minute >= start && minute < end;
    return (
      (minute >= start && days.includes(day)) || (minute < end && days.includes((day + 6) % 7))
    );
  } catch {
    return false;
  }
}

describe('the restaurant clock', () => {
  it('gives the local weekday, minute and date', () => {
    expect(at('2026-08-15T01:00')).toEqual({ day: 6, minute: 60, date: '2026-08-15' });
    // Midnight is minute 0, never 24:05.
    expect(at('2026-08-15T00:05')).toEqual({ day: 6, minute: 5, date: '2026-08-15' });
    // The local date, not the UTC one (still 14 Aug in UTC).
    expect(localClock(PKT, '2026-08-14T22:30:00Z')).toEqual({
      day: 6,
      minute: 210,
      date: '2026-08-15',
    });
  });

  it('follows daylight saving: London springs forward on 29 Mar 2026', () => {
    expect(localClock(LONDON, '2026-03-28T23:30:00Z')).toEqual({
      day: 6,
      minute: 23 * 60 + 30,
      date: '2026-03-28',
    });
    expect(localClock(LONDON, '2026-03-29T00:30:00Z')).toEqual({
      day: 0,
      minute: 30,
      date: '2026-03-29',
    });
    // 01:00 UTC is 02:00 BST: the hour from 01:00 to 02:00 never happens there.
    expect(localClock(LONDON, '2026-03-29T01:00:00Z')).toEqual({
      day: 0,
      minute: 120,
      date: '2026-03-29',
    });
    expect(localClock(LONDON, '2026-08-14T22:30:00Z')).toEqual({
      day: 5,
      minute: 23 * 60 + 30,
      date: '2026-08-14',
    });
  });

  it('gives no clock for a bad zone or date, so callers fail closed', () => {
    expect(localClock('Invalid/Zone', pkt('2026-08-14T13:00'))).toBeUndefined();
    expect(localClock(PKT, 'not a date')).toBeUndefined();
    // Asking again still answers, and a bad zone never breaks a good one.
    expect(localClock('Invalid/Zone', pkt('2026-08-14T13:00'))).toBeUndefined();
    expect(at('2026-08-14T13:00')).toEqual({ day: 5, minute: 780, date: '2026-08-14' });
  });

  it('reads times and moves dates by calendar days', () => {
    expect(toMinute('00:00')).toBe(0);
    expect(toMinute('12:30')).toBe(750);
    expect(toMinute('23:59')).toBe(1439);
    for (const bad of ['24:00', '7:00', '12:60', '', 'noon']) expect(toMinute(bad)).toBeNaN();
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    // The day London's clocks change is still one calendar day.
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
  });

  it('judges a turn at receivedAt only when it is a real time', () => {
    const now = '2026-08-14T08:00:00.000Z';
    const late = '2026-08-14T08:30:00.000Z';
    expect(turnInstant({ now })).toBe(now);
    expect(turnInstant({ now, receivedAt: late })).toBe(late);
    expect(turnInstant({ now, receivedAt: 'yesterday-ish' })).toBe(now);
    expect(turnInstant({ now, receivedAt: '' })).toBe(now);
  });
});

describe('opening hours are unchanged', () => {
  const windows: Company['openingHours'][] = [
    { start: '10:00', end: '17:00', days: [3] },
    { start: '18:00', end: '02:00', days: [3] },
    { start: '00:00', end: '00:00', days: everyDay },
    { start: '00:00', end: '00:00', days: [] },
    { start: '23:00', end: '02:00', days: [5, 6] },
    { start: '00:00', end: '03:00', days: [6] },
    { start: '12:00', end: '15:00', days: [1, 2, 3, 4, 5] },
    { start: '25:00', end: '02:00', days: everyDay },
  ];
  // Every half hour across London's clock change and a normal week in Karachi.
  const times = ['2026-03-26T00:00:00Z', '2026-08-10T00:00:00Z'].flatMap((from) =>
    Array.from({ length: 8 * 48 }, (_, i) =>
      new Date(Date.parse(from) + i * 30 * 60_000).toISOString(),
    ),
  );

  it('answers exactly as the old isOpen did, and reads the same weekday and minute', () => {
    for (const timezone of [PKT, LONDON, 'Invalid/Zone'])
      for (const openingHours of windows) {
        const restaurant = { ...company, timezone, openingHours };
        for (const now of times) {
          expect(
            isOpen(restaurant, now),
            `${timezone} ${JSON.stringify(openingHours)} ${now}`,
          ).toBe(isOpenBefore(restaurant, now));
        }
      }
    for (const timezone of [PKT, LONDON])
      for (const now of times) {
        const clock = localClock(timezone, now)!;
        expect({ day: clock.day, minute: clock.minute }).toEqual(clockBefore(timezone, now));
      }
    expect(isOpen(company, 'not a date')).toBe(false);
  });

  it('keeps the engine cases: same day, overnight against the opening day, bad zone', () => {
    const restaurant = { ...company, openingHours: { start: '10:00', end: '17:00', days: [3] } };
    expect(isOpen(restaurant, '2026-09-09T10:00:00Z')).toBe(true);
    expect(isOpen(restaurant, '2026-09-09T13:30:00Z')).toBe(false);
    const overnight = { ...company, openingHours: { start: '18:00', end: '02:00', days: [3] } };
    expect(isOpen(overnight, '2026-09-09T20:00:00Z')).toBe(true);
    expect(isOpen(overnight, '2026-09-10T20:00:00Z')).toBe(false);
    expect(isOpen({ ...overnight, timezone: 'Invalid/Zone' }, '2026-09-09T20:00:00Z')).toBe(false);
  });

  it('still says when a closed restaurant opens again', () => {
    const weekdays = {
      ...company,
      openingHours: { start: '12:00', end: '23:00', days: [1, 2, 3, 4, 5] },
    };
    const saturday = pkt('2026-08-15T10:00');
    expect(closedText(weekdays, 'en', saturday)).toBe(
      'We are currently closed. Ordering hours are 12:00–23:00. We open again on Monday at 12:00.',
    );
    expect(closedText(weekdays, 'roman-ur', pkt('2026-08-13T23:30'))).toBe(
      'Hum is waqt band hain. Order ka waqt 12:00–23:00 hai. Hum kal 12:00 baje dobara khulenge.',
    );
    expect(closedText(weekdays, 'ur', pkt('2026-08-14T09:00'))).toBe(
      'ہم اس وقت بند ہیں۔ آرڈر کا وقت 12:00–23:00 ہے۔ ہم آج 12:00 بجے دوبارہ کھلیں گے۔',
    );
  });
});

describe('deal windows', () => {
  it('uses the opening-hours rule for every kind of window', () => {
    const lunch = { start: '12:00', end: '15:00', days: [1, 2, 3, 4, 5] };
    expect(inWindow(lunch, at('2026-08-14T12:00')!)).toBe(true);
    expect(inWindow(lunch, at('2026-08-14T15:00')!)).toBe(false);
    expect(inWindow(lunch, at('2026-08-15T13:00')!)).toBe(false);
    const allDay = { start: '00:00', end: '00:00', days: [0, 6] };
    expect(inWindow(allDay, at('2026-08-15T23:59')!)).toBe(true);
    expect(inWindow(allDay, at('2026-08-14T23:59')!)).toBe(false);
    expect(inWindow({ start: '9:00', end: '15:00', days: everyDay }, at('2026-08-14T12:00')!)).toBe(
      false,
    );
  });

  it('calls a window wholly before 06:00 a night window', () => {
    expect(isNightWindow({ start: '00:00', end: '03:00' })).toBe(true);
    expect(isNightWindow({ start: '01:00', end: '06:00' })).toBe(true);
    expect(isNightWindow({ start: '00:00', end: '06:01' })).toBe(false);
    expect(isNightWindow({ start: '23:00', end: '02:00' })).toBe(false);
    expect(isNightWindow({ start: '12:00', end: '15:00' })).toBe(false);
    expect(isNightWindow({ start: '00:00', end: '00:00' })).toBe(false);
  });

  it('dates a crossing-midnight tail and a night window by the evening they belong to', () => {
    // I: Fri-only 23:00–02:00 at Sat 01:00 is still Friday's.
    const late = { start: '23:00', end: '02:00', days: [5] };
    expect(status(late, at('2026-08-15T01:00'))).toBe('on');
    expect(occurrenceDate(late, at('2026-08-15T01:00')!)).toBe('2026-08-14');
    expect(occurrenceDate(late, at('2026-08-14T23:30')!)).toBe('2026-08-14');
    // J: Fri-only 00:00–02:00 is Thursday night, so it is off at Sat 01:00.
    const night = { start: '00:00', end: '02:00', days: [5] };
    expect(status(night, at('2026-08-15T01:00'))).toBe('later');
    expect(status(night, at('2026-08-14T01:00'))).toBe('on');
    expect(occurrenceDate(night, at('2026-08-14T01:00')!)).toBe('2026-08-13');
    // K: 18:00–00:00 ends exactly at midnight.
    const evening = { start: '18:00', end: '00:00', days: [5] };
    expect(status(evening, at('2026-08-14T23:59'))).toBe('on');
    expect(status(evening, at('2026-08-15T00:00'))).toBe('later');
    expect(occurrenceDate(evening, at('2026-08-14T23:59')!)).toBe('2026-08-14');
    expect(occurrenceDate(evening, at('2026-08-14T17:59')!)).toBeUndefined();
  });

  it('keeps an overnight deal on for the tail of its end date (A, B)', () => {
    const midnight = { start: '23:00', end: '02:00', days: everyDay, endDate: '2026-08-14' };
    expect(status(midnight, at('2026-08-15T01:00'))).toBe('on');
    expect(status(midnight, at('2026-08-15T01:59'))).toBe('on');
    expect(status(midnight, at('2026-08-15T02:00'))).toBe('ended');
    expect(status(midnight, at('2026-08-15T03:00'))).toBe('ended');
    expect(dealEndsAt(midnight)).toEqual({ date: '2026-08-15', minute: 120 });
  });

  it('does not count the night before the start date (C, D)', () => {
    const midnight = { start: '23:00', end: '02:00', days: everyDay, startDate: '2026-03-01' };
    expect(status(midnight, at('2026-03-01T01:00'))).toBe('later');
    expect(status(midnight, at('2026-03-01T23:30'))).toBe('on');
    expect(status(midnight, at('2026-03-02T01:00'))).toBe('on');
    // The same for a night window: the night of 28 Feb is before it starts.
    const night = { start: '00:00', end: '03:00', days: everyDay, startDate: '2026-03-01' };
    expect(status(night, at('2026-03-01T01:00'))).toBe('later');
    expect(status(night, at('2026-03-02T01:00'))).toBe('on');
  });

  it('ends a deal once its last window is over, not at the end of the date (E, F, L)', () => {
    // E: no lunch window left on the end date after 15:00.
    const lunch = { start: '12:00', end: '15:00', days: everyDay, endDate: '2026-08-14' };
    expect(status(lunch, at('2026-08-14T11:00'))).toBe('later');
    expect(status(lunch, at('2026-08-14T13:00'))).toBe('on');
    expect(status(lunch, at('2026-08-14T15:00'))).toBe('ended');
    expect(status(lunch, at('2026-08-14T16:00'))).toBe('ended');
    // F: a weekend deal ending on a Friday has its last day on Sunday 9 Aug.
    const weekend = { start: '12:00', end: '15:00', days: [0, 6], endDate: '2026-08-14' };
    expect(lastOccurrence(weekend)).toBe('2026-08-09');
    expect(status(weekend, at('2026-08-09T13:00'))).toBe('on');
    expect(status(weekend, at('2026-08-10T13:00'))).toBe('ended');
    // L: an all-day deal runs to the end of its end date.
    const allDay = { start: '00:00', end: '00:00', days: everyDay, endDate: '2026-08-14' };
    expect(status(allDay, at('2026-08-14T23:59'))).toBe('on');
    expect(status(allDay, at('2026-08-15T00:00'))).toBe('ended');
    expect(dealEndsAt(allDay)).toEqual({ date: '2026-08-15', minute: 0 });
  });

  it('dates a night window by its evening at both ends', () => {
    // "Friday night" 00:00–03:00 is stored on Saturday; ending 14 Aug keeps the night of 14 Aug.
    const fridayNight = { start: '00:00', end: '03:00', days: [6], endDate: '2026-08-14' };
    expect(lastOccurrence(fridayNight)).toBe('2026-08-14');
    expect(dealEndsAt(fridayNight)).toEqual({ date: '2026-08-15', minute: 180 });
    expect(status(fridayNight, at('2026-08-15T02:00'))).toBe('on');
    expect(status(fridayNight, at('2026-08-15T03:00'))).toBe('ended');
    expect(dealEndsAt({ start: '12:00', end: '15:00', days: [5], endDate: '2026-08-14' })).toEqual({
      date: '2026-08-14',
      minute: 900,
    });
  });

  it('keeps a deal later inside its daily window before the start date (G)', () => {
    const lunch = { start: '12:00', end: '15:00', days: [1, 2, 3, 4, 5], startDate: '2026-03-02' };
    expect(status(lunch, at('2026-02-23T13:00'))).toBe('later');
    expect(status(lunch, at('2026-03-02T13:00'))).toBe('on');
  });

  it('finds schedules that can never be on (H)', () => {
    const never = {
      start: '12:00',
      end: '15:00',
      days: [5],
      startDate: '2026-08-04',
      endDate: '2026-08-04',
    };
    expect(scheduleNeverOccurs(never)).toBe(true);
    expect(lastOccurrence(never)).toBeUndefined();
    // Such a deal has nothing left, so it is ended rather than "later" for ever.
    expect(status(never, at('2026-08-01T13:00'))).toBe('ended');
    expect(scheduleNeverOccurs({ ...never, days: [2] })).toBe(false);
    expect(scheduleNeverOccurs({ ...never, endDate: undefined })).toBe(false);
    expect(scheduleNeverOccurs({ ...never, days: [] })).toBe(true);
    expect(scheduleNeverOccurs({ ...never, days: [2], startDate: '2026-08-05' })).toBe(true);
    // Friday night (stored Saturday) on 14 Aug occurs; Thursday night (stored Friday) does not.
    const night = { start: '00:00', end: '03:00', startDate: '2026-08-14', endDate: '2026-08-14' };
    expect(scheduleNeverOccurs({ ...night, days: [6] })).toBe(false);
    expect(scheduleNeverOccurs({ ...night, days: [5] })).toBe(true);
  });

  it('fails closed without a clock', () => {
    const lunch = { start: '12:00', end: '15:00', days: everyDay, endDate: '2026-08-14' };
    const none = localClock('Invalid/Zone', pkt('2026-08-14T13:00'));
    expect(dealOpenAt(lunch, none)).toBe(false);
    expect(dealEnded(lunch, none)).toBe(false);
    // No schedule means whenever the restaurant is open.
    expect(dealOpenAt(undefined, none)).toBe(true);
    expect(dealEnded(undefined, at('2026-08-20T13:00'))).toBe(false);
  });

  it('follows London wall-clock time across the clock change', () => {
    const london = (iso: string) => localClock(LONDON, iso);
    const early = { start: '01:00', end: '03:00', days: [0] };
    expect(dealOpenAt(early, london('2026-03-29T00:59:00Z'))).toBe(false);
    expect(dealOpenAt(early, london('2026-03-29T01:00:00Z'))).toBe(true); // 02:00 BST
    expect(dealOpenAt(early, london('2026-03-29T02:00:00Z'))).toBe(false); // 03:00 BST
    // Saturday night 00:00–03:00 (stored Sunday) ending 28 Mar runs to 03:00 BST.
    const night = { start: '00:00', end: '03:00', days: [0], endDate: '2026-03-28' };
    expect(occurrenceDate(night, london('2026-03-29T01:30:00Z')!)).toBe('2026-03-28');
    expect(status(night, london('2026-03-29T01:30:00Z'))).toBe('on');
    expect(status(night, london('2026-03-29T02:00:00Z'))).toBe('ended');
    // An evening deal starts at 18:00 local, before and after the change.
    const evening = { start: '18:00', end: '22:00', days: everyDay };
    expect(dealOpenAt(evening, london('2026-03-28T17:30:00Z'))).toBe(false); // 17:30 GMT
    expect(dealOpenAt(evening, london('2026-03-29T17:30:00Z'))).toBe(true); // 18:30 BST
  });
});
