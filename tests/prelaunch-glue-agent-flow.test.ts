// What Agent flow tells owners the bot does, after the pre-launch fixes.
import { describe, expect, it } from 'vitest';
import { buildAgentFlow } from '../server/agent-flow';
import { company, demoApp } from './helpers/demo-app';

const app = demoApp();

describe('what Agent flow says the bot does', () => {
  it('describes the behaviour the pre-launch fixes shipped', async () => {
    const flow = JSON.stringify(await buildAgentFlow(app.repo(), company, 'owner'));
    for (const text of [
      'shared locations are read as text',
      'gets a fresh summary to confirm',
      'One more than 2 hours late pauses the bot for that chat',
      'put in the chat for staff',
      '25 messages from one customer within a minute pause the bot for that customer for 15 minutes.',
      'used for up to 12 hours',
      "after 10 minutes it answers the customer's next message, unless staff reply",
      'tried again up to 2 times',
      'recent messages carry them as the customer wrote them',
      'allergy answers included',
      'in English, Urdu or Roman Urdu',
      'An order confirmation always goes out',
    ])
      expect(flow, text).toContain(text);
    for (const stale of [
      'Sent only as',
      'handed to staff instead of answered late',
      '15 or more messages',
      'no automatic retry',
      'images and other media go straight to staff',
    ])
      expect(flow, stale).not.toContain(stale);
  });
});
