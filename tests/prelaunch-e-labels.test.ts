import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Activity } from '../src/components/Operations';
import { limitNote } from '../src/components/Inbox';
import {
  ATTENTION_CODE_LABELS,
  describeCorrection,
  describeStep,
  describeTrace,
  NOTICE_LABELS,
  SKIP_LABELS,
} from '../src/shared/explain';
import { seedCompanies, seedConversations } from '../src/shared/seed';
import type { Conversation, Trace } from '../src/shared/types';
import { bootstrap, render } from './prelaunch-e-helpers';

describe('wording for what the bot and the pipeline did', () => {
  it('uses the new pause rules', () => {
    expect(SKIP_LABELS.late).toBe(
      'This message reached Orderly more than 2 hours late, so staff were asked to look at it; the bot answers the customer’s next message.',
    );
    expect(NOTICE_LABELS.burst).toBe(
      'Many messages arrived within a minute, so automatic replies to this customer paused for 15 minutes.',
    );
    expect(NOTICE_LABELS.ai_error).toBe(
      'The AI model could not answer, so the chat paused; after 10 minutes the bot answers the customer’s next message, unless staff reply.',
    );
  });

  it('names the allergy safeguards and order status answers', () => {
    expect(describeStep('order_status')).toBe('Told the customer where their order is');
    expect(describeStep('allergy_question_guarded')).toBe('Answered an allergy question safely');
    expect(describeStep('allergy_assurance_ignored')).toBe('Dropped an allergy promise');
    expect(describeCorrection('allergy_question_guarded')).toMatch(/approved allergy answer/);
    expect(describeCorrection('allergy_assurance_ignored')).toMatch(
      /promised something about allergies/,
    );
  });

  it('names new events in Activity, and why staff were asked to look', () => {
    expect(describeTrace('menu_sync_stale')).toBe(
      'Menu Sheet unreadable, last good menu still used',
    );
    expect(describeTrace('order_followup')).toBe('Customer told their order is still waiting');
    expect(describeTrace('whatsapp.not_sent')).toBe('WhatsApp reply not sent');
    expect(describeTrace('budget.settle_failed')).toBe('AI reply cost not recorded');
    expect(describeTrace('staff_attention', 'ai_quota')).toBe(
      'Staff asked to look at a chat: the AI account has no quota or credit left',
    );
    expect(describeTrace('staff_attention', 'a_new_code')).toBe('Staff asked to look at a chat');
    expect(describeTrace('settings.updated')).toBeUndefined();
    for (const code of [
      'ai_auth',
      'ai_quota',
      'ai_rate_limited',
      'ai_overloaded',
      'ai_timeout',
      'ai_model_not_found',
      'ai_bad_output',
      'ai_unreachable',
      'ai_provider_error',
      'store_unavailable',
      'burst',
      'late',
    ])
      expect(ATTENTION_CODE_LABELS[code], code).toBeTruthy();
  });

  it('shows those names on the Activity page, and uses the jobs the workspace already loaded', () => {
    const traces: Trace[] = [
      {
        id: 't1',
        companyId: seedCompanies[0]!.id,
        action: 'staff_attention',
        code: 'ai_overloaded',
        detail: 'The AI provider is overloaded.',
        createdAt: '2026-10-18T10:00:00.000Z',
      },
      {
        id: 't2',
        companyId: seedCompanies[0]!.id,
        action: 'settings.updated',
        detail: 'Saved.',
        createdAt: '2026-10-18T09:00:00.000Z',
      },
    ];
    const html = render(Activity, bootstrap({ traces, jobs: [] }), 'activity');
    expect(html).toContain('Staff asked to look at a chat: the AI provider is overloaded');
    expect(html).toContain('Settings updated');
    expect(html).toContain('No pending or failed work.');
    const source = readFileSync(join(process.cwd(), 'src/components/Operations.tsx'), 'utf8');
    expect(source).toMatch(
      /if \(data\.jobs\) return;\s*let active = true;\s*api<\{ jobs: Job\[\] \}>\('\/activity'/,
    );
  });
});

describe('Inbox notes for the new pauses', () => {
  const now = Date.parse('2026-10-18T10:20:00.000Z');
  const paused = (reason: 'burst' | 'ai_error' | 'late', until: string): Conversation => ({
    ...seedConversations[0]!,
    channel: 'whatsapp',
    customerPhone: '+923001234567',
    mode: 'human',
    limitPause: { reason, at: '2026-10-18T10:05:00.000Z', until, limit: 25 },
  });

  it('says why the bot paused and when it answers again', () => {
    const until = '2026-10-18T10:35:00.000Z';
    expect(limitNote(paused('burst', until), now)).toMatch(
      /^AI paused: this customer sent many messages at once\. The bot answers them again from about \d{1,2}:\d{2}\s(am|pm)\.$/,
    );
    expect(limitNote(paused('ai_error', until), now)).toMatch(
      /^AI paused: the AI model could not answer\. The bot answers this customer’s next message from about \d{1,2}:\d{2}\s(am|pm)\.$/,
    );
    // A late message pauses only until its own time: the bot answers the next message.
    expect(limitNote(paused('late', '2026-10-18T10:05:00.000Z'), now)).toBe(
      'The bot will answer this customer’s next message.',
    );
  });
});
