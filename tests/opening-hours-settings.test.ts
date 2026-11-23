// Settings → opening hours. 24 hours is chosen by name: two equal times (11 AM picked for 11 PM)
// once kept a restaurant open all night.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { Settings } from '../src/components/Settings';
import {
  clockWords,
  hoursProblem,
  hoursSummary,
  isAllDay,
  SAME_TIMES,
  savedHours,
} from '../src/lib/opening-hours';
import { Workspace } from '../src/lib/workspace';
import { buildAgentFlow } from '../server/agent-flow';
import { MemoryRepository } from '../server/repository';
import { isOpen } from '../src/domain/engine';
import { seedCompanies } from '../src/shared/seed';
import type { Bootstrap, Company } from '../src/shared/types';

const days = [0, 1, 2, 3, 4, 5, 6];
const company = (start: string, end: string): Company => ({
  ...seedCompanies[0]!,
  openingHours: { start, end, days },
});

describe('opening hours in the Settings form', () => {
  it('refuses two equal times unless 24 hours is chosen', () => {
    expect(hoursProblem({ start: '11:00', end: '11:00' }, false)).toBe(SAME_TIMES);
    expect(hoursProblem({ start: '11:00', end: '11:00' }, true)).toBe('');
    expect(hoursProblem({ start: '11:00', end: '23:00' }, false)).toBe('');
    expect(hoursProblem({ start: '15:00', end: '03:00' }, false)).toBe('');
  });

  it('saves 24 hours as 00:00–00:00, and any other hours as typed', () => {
    const typed = { start: '11:00', end: '23:00', days: [1, 2] };
    expect(savedHours(typed, false)).toBe(typed);
    const all = savedHours(typed, true);
    expect(all).toEqual({ start: '00:00', end: '00:00', days: [1, 2] });
    expect(isAllDay(all)).toBe(true);
    // Open on the days chosen, all day, as before.
    const restaurant = { ...company('00:00', '00:00'), openingHours: all };
    expect(isOpen(restaurant, '2026-11-23T23:30:00.000Z')).toBe(true); // Tuesday 04:30 in Karachi
    expect(isOpen(restaurant, '2026-11-22T23:30:00.000Z')).toBe(true); // Monday 04:30
    expect(isOpen(restaurant, '2026-11-25T23:30:00.000Z')).toBe(false); // Thursday 04:30
  });

  it('says the hours in words, so a swapped AM and PM is seen', () => {
    expect(hoursSummary({ start: '15:00', end: '03:00' }, false)).toBe(
      'Open 3:00 PM to 3:00 AM the next day (12 hours). The bot takes orders only in these hours.',
    );
    expect(hoursSummary({ start: '03:00', end: '15:00' }, false)).toContain(
      'Open 3:00 AM to 3:00 PM (12 hours)',
    );
    expect(hoursSummary({ start: '11:00', end: '10:30' }, false)).toContain(
      'the next day (23 hours 30 minutes)',
    );
    expect(hoursSummary({ start: '12:00', end: '00:00' }, false)).toContain(
      'Open 12:00 PM (noon) to 12:00 AM (midnight) the next day (12 hours)',
    );
    expect(hoursSummary({ start: '11:00', end: '11:00' }, true)).toBe(
      'Open 24 hours on the days you choose.',
    );
    expect(hoursSummary({ start: '', end: '03:00' }, false)).toBe('');
    expect(clockWords('09:05')).toBe('9:05 AM');
    expect(clockWords('')).toBe('');
  });

  const page = (saved: Company) => {
    const data = {
      mode: 'demo',
      role: 'owner',
      company: saved,
      companies: [saved],
      products: [],
      orders: [],
      conversations: [],
      integrations: [],
      usage: [],
      traces: [],
    } as unknown as Bootstrap;
    return renderToStaticMarkup(
      createElement(
        Workspace.Provider,
        {
          value: {
            data,
            page: 'settings',
            navigate: () => undefined,
            refresh: async () => undefined,
            mutate: async () => undefined,
            notify: () => undefined,
            switchCompany: () => undefined,
            settingsReloads: 0,
          } as never,
        },
        createElement(Settings),
      ),
    );
  };

  it('shows the hours in words and 24 hours off for set hours, on for a business that has it', () => {
    const set = page(company('15:00', '03:00'));
    expect(set).toContain('Open 3:00 PM to 3:00 AM the next day (12 hours).');
    expect(set).toContain('Open 24 hours');
    expect(set).not.toContain('Matching opening and closing times');
    const toggle = (html: string) =>
      /<input[^>]*class="toggle"[^>]*>(?=Open 24 hours)/.exec(html)![0];
    expect(toggle(set)).not.toContain('checked');
    const all = page(company('11:00', '11:00'));
    expect(toggle(all)).toContain('checked');
    expect(all).toContain('Open 24 hours on the days you choose.');
    // The times say nothing while open 24 hours.
    expect(all.match(/<input[^>]*type="time"[^>]*disabled/g)).toHaveLength(2);
  });

  it('checks the hours before saving, and re-reads 24 hours from what was saved', () => {
    const source = readFileSync('src/components/Settings.tsx', 'utf8');
    expect(source).toContain('closesAt.current?.setCustomValidity(hoursError)');
    expect(source).toContain('openingHours: savedHours(draft.openingHours, allDay)');
    expect(source.match(/setAllDay\(isAllDay\(draftFrom\(/g)).toHaveLength(2);
  });

  it('says Open 24 hours on the Agent flow page', async () => {
    const hours = async (saved: Company) =>
      (await buildAgentFlow(new MemoryRepository(), saved, 'owner')).nodes
        .find((node) => node.id === 'knowledge')!
        .facts.find((fact) => fact.label === 'Hours')!.value;
    expect(await hours(company('11:00', '11:00'))).toBe('Open 24 hours · every day');
    expect(await hours(company('15:00', '03:00'))).toBe('15:00–03:00 · every day');
  });
});
