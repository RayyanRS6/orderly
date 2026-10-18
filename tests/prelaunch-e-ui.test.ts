import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Overview } from '../src/components/Orders';
import { BotSettings } from '../src/components/BotSettings';
import { AI_LIMIT_DEFAULTS, AI_LIMIT_RANGES } from '../src/shared/models';
import { seedCompanies } from '../src/shared/seed';
import { bootstrap, check, render } from './prelaunch-e-helpers';

describe('readiness rows', () => {
  const readiness = [
    check('fulfillment', false, { label: 'Add a delivery area, or offer pickup' }),
    check('privacy', true, {
      warning:
        'Click Connect and test again to confirm no data-sharing or training opt-in is on for the AI provider account.',
    }),
  ];

  it('links the delivery row to the delivery settings wherever the checklist shows', () => {
    for (const [component, page] of [
      [Overview, 'overview'],
      [BotSettings, 'bot'],
    ] as const) {
      const html = render(component, bootstrap({ readiness }), page);
      expect(html).toContain('Add a delivery area, or offer pickup');
      expect(html).toContain('Delivery settings');
    }
    const done = render(
      Overview,
      bootstrap({ readiness: [check('fulfillment', true)] }),
      'overview',
    );
    expect(done).not.toContain('Delivery settings');
    expect(readFileSync(join(process.cwd(), 'src/components/Settings.tsx'), 'utf8')).toContain(
      '<section id="delivery-areas"',
    );
  });

  it('asks the owner to confirm their AI account settings when readiness warns', () => {
    const html = render(BotSettings, bootstrap({ readiness }), 'bot');
    expect(html).toContain('Confirm your AI account settings');
    expect(html).toContain('Click Connect and test again to confirm no data-sharing');
    expect(render(BotSettings, bootstrap({ readiness: [] }), 'bot')).not.toContain(
      'Confirm your AI account settings',
    );
  });
});

describe('Bot settings: AI account confirmations', () => {
  const withProvider = (provider: 'openai' | 'gemini') =>
    bootstrap({
      company: { ...seedCompanies[0]!, ai: { provider, model: 'model-1', monthlyBudgetUsd: 10 } },
    });

  it('asks every provider for no training opt-in, and Gemini also for billing', () => {
    const openai = render(BotSettings, withProvider('openai'), 'bot');
    expect(openai).toContain('No data-sharing or model-training opt-in is turned on for this');
    expect(openai).not.toContain('billing turned on (paid tier)');
    expect(openai).toContain(
      'Orderly tells customers at the start of each chat that they are talking to an automated assistant.',
    );
    expect(openai).not.toContain('I will let customers know');
    const gemini = render(BotSettings, withProvider('gemini'), 'bot');
    expect(gemini).toContain('This key’s Google Cloud project has billing turned on (paid tier).');
    expect(gemini).toContain('a billed Google Cloud project is required');
    expect(gemini).toContain('Free-tier keys must not receive customer messages.');
  });

  it('sends the confirmations with Connect and test', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/BotSettings.tsx'), 'utf8');
    expect(source).toContain(
      "attest: { noTrainingOptIn: true, ...(ai.provider === 'gemini' && { paidTier: true }) },",
    );
    expect(source).toMatch(/const canConnect =\s*usesAi && approved && attested/);
  });
});

describe('Bot settings: messages per customer per minute', () => {
  it('shows the third limit with its range and default, and the new defaults in the hints', () => {
    const html = render(BotSettings, bootstrap(), 'bot');
    const [min, max] = AI_LIMIT_RANGES.messagesPerCustomerPerMinute;
    expect(html).toContain('Messages per customer per minute');
    expect(html).toContain(`min="${min}" max="${max}"`);
    expect(html).toContain(`value="${AI_LIMIT_DEFAULTS.messagesPerCustomerPerMinute}"`);
    expect(html).toContain('Default 1,500. One WhatsApp order takes about 8–10 AI replies.');
    expect(html).toContain('Default 100.');
    expect(html).toContain('pause the bot for that customer for 15 minutes');
    const saved = render(
      BotSettings,
      bootstrap({
        company: {
          ...seedCompanies[0]!,
          aiLimits: {
            repliesPerHour: 450,
            repliesPerCustomerPerHour: 12,
            messagesPerCustomerPerMinute: 40,
          },
        },
      }),
      'bot',
    );
    expect(saved).toContain('value="40"');
  });

  it('always saves all three limits', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/BotSettings.tsx'), 'utf8');
    expect(source).toMatch(
      /aiLimits: \{\s*repliesPerHour: Number\(repliesPerHour\),\s*repliesPerCustomerPerHour: Number\(repliesPerCustomer\),\s*messagesPerCustomerPerMinute: Number\(messagesPerMinute\),\s*\}/,
    );
  });
});
