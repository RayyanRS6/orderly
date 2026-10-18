import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { processJob } from '../server/service';
import {
  MEDIA_HANDOFF_TEXT,
  locationText,
  metaEchoText,
  metaInboundContent,
} from '../server/whatsapp/inbound';
import { createConversation } from '../src/domain/engine';
import { seedCompanies } from '../src/shared/seed';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'unused' } }) },
    rpc: async () => ({ error: { message: 'no scheduler in tests' } }),
  }),
}));

const company = seedCompanies[0];
const customer = '923001112233';
let repo: MemoryRepository;
beforeEach(async () => {
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'live');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('META_APP_SECRET', 'test-app-secret');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Unexpected network request'))),
  );
  await repo.saveIntegration(
    company.id,
    { kind: 'whatsapp', configured: true, status: 'connected', config: { phoneNumberId: '555' } },
    encryptSecret('token'),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const at = () => String(Math.floor(Date.now() / 1000));
async function webhook(value: Record<string, unknown>, field = 'messages') {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field, value: { metadata: { phone_number_id: '555' }, ...value } }] }],
  });
  const response = await createApp(repo).request('http://127.0.0.1/api/webhooks/whatsapp', {
    method: 'POST',
    body,
    headers: {
      'x-hub-signature-256': `sha256=${createHmac('sha256', 'test-app-secret').update(body).digest('hex')}`,
    },
  });
  expect(response.status).toBe(200);
}
const message = (id: string, fields: Record<string, unknown>) => ({
  id,
  from: customer,
  timestamp: at(),
  ...fields,
});
const incoming = async () =>
  (await repo.listCompanyJobs(company.id))
    .filter((job) => job.kind === 'incoming')
    .sort((a, b) => String(a.payload.messageId).localeCompare(String(b.payload.messageId)));
// Runs every incoming job, in whatever order the queue allows (one customer's jobs run FIFO).
async function drain() {
  for (let pass = 0; pass < 4; pass++)
    for (const job of await incoming())
      if ((await repo.getJob(job.id))?.status === 'pending') await processJob(repo, job.id);
}
const chat = async () =>
  (await repo.listConversations(company.id)).find((c) => c.customerPhone === customer)!;

describe('what a WhatsApp Cloud API message becomes', () => {
  it('ignores reactions, reactions taken back and system notices', () => {
    for (const fields of [
      { type: 'reaction', reaction: { message_id: 'wamid.x', emoji: '👍' } },
      { type: 'reaction', reaction: { message_id: 'wamid.x' } },
      { type: 'system', system: { body: 'User changed number', type: 'user_changed_number' } },
      { type: 'request_welcome' },
    ])
      expect(metaInboundContent(fields)).toMatchObject({ ignore: true });
    expect(metaInboundContent({ type: 'reaction', reaction: {} })).toEqual({
      ignore: true,
      trace: { action: 'whatsapp.reaction', detail: expect.not.stringContaining('👍') },
    });
  });

  it('reads captions, locations and template buttons instead of handing them to staff', () => {
    expect(metaInboundContent({ type: 'image', image: { caption: ' 2 biryani please ' } })).toEqual(
      { text: '2 biryani please (sent with a photo)' },
    );
    expect(metaInboundContent({ type: 'video', video: { caption: 'دو بریانی' } })).toEqual({
      text: 'دو بریانی (ویڈیو کے ساتھ)',
    });
    expect(
      metaInboundContent({ type: 'document', document: { caption: 'Order list', filename: 'a' } }),
    ).toEqual({ text: 'Order list (sent with a document)' });
    expect(
      metaInboundContent({
        type: 'location',
        location: {
          latitude: 31.5204,
          longitude: 74.3587,
          name: 'Home',
          address: 'House 5, Street 2, Gulberg III',
        },
      }),
    ).toEqual({
      text: 'Location shared: Home, House 5, Street 2, Gulberg III (31.5204, 74.3587)',
    });
    // A template button's label is text; its payload never becomes a bot action.
    expect(
      metaInboundContent({ type: 'button', button: { text: 'Yes please', payload: 'confirm:3' } }),
    ).toEqual({ text: 'Yes please' });
    expect(metaInboundContent({ type: 'button', button: { payload: 'menu' } })).toEqual({
      text: 'menu',
    });
  });

  it('keeps interactive replies and hands only unreadable messages to staff', () => {
    expect(
      metaInboundContent({
        type: 'interactive',
        interactive: { button_reply: { id: 'confirm:4', title: 'Confirm' } },
      }),
    ).toEqual({ text: 'Confirm', action: { type: 'confirm', revision: 4 } });
    expect(metaInboundContent({ type: 'text', text: { body: 'menu' } })).toEqual({ text: 'menu' });
    for (const fields of [
      { type: 'audio', audio: { id: 'a' } },
      { type: 'sticker', sticker: { id: 's' } },
      { type: 'image', image: { id: 'i' } },
      { type: 'image', image: { id: 'i', caption: '   ' } },
      { type: 'contacts', contacts: [{}] },
      { type: 'unsupported' },
      { type: 'location', location: {} },
    ])
      expect(metaInboundContent(fields), JSON.stringify(fields)).toEqual({
        text: MEDIA_HANDOFF_TEXT,
        action: { type: 'handoff' },
      });
  });

  it('words a shared location without inventing a link', () => {
    expect(locationText({ latitude: '24.8607', longitude: '67.0011' })).toBe(
      'Location shared: (24.8607, 67.0011)',
    );
    expect(locationText({ latitude: 200, longitude: 67, address: 'DHA Phase 6' })).toBe(
      'Location shared: DHA Phase 6',
    );
    expect(locationText({ latitude: 31.5, longitude: 74.3 })).not.toMatch(/https?:/);
    expect(locationText(undefined)).toBeUndefined();
  });

  it('does not let a staff reaction in the Business app count as a takeover', () => {
    expect(metaEchoText({ type: 'reaction', reaction: { emoji: '❤️' } })).toBeUndefined();
    expect(metaEchoText({ type: 'text', text: { body: 'Coming soon' } })).toBe('Coming soon');
    expect(metaEchoText({ type: 'image', image: { caption: 'Today’s special' } })).toBe(
      'Staff sent a photo in WhatsApp: Today’s special',
    );
    expect(metaEchoText({ type: 'sticker' })).toBe('Staff sent a sticker message in WhatsApp.');
  });
});

describe('the Meta webhook', () => {
  it('saves no job for reactions or system notices and leaves the reply window alone', async () => {
    const conversation = createConversation(
      company.id,
      customer,
      'whatsapp',
      new Date().toISOString(),
    );
    conversation.version = 1;
    await repo.saveConversation(conversation, 0);
    await webhook({
      messages: [
        message('wamid.r1', { type: 'reaction', reaction: { message_id: 'wamid.0', emoji: '👍' } }),
        message('wamid.r2', { type: 'reaction', reaction: { message_id: 'wamid.0' } }),
        message('wamid.s1', {
          type: 'system',
          system: { body: 'changed', type: 'user_changed_number' },
        }),
        message('wamid.w1', { type: 'request_welcome' }),
      ],
    });
    expect(await incoming()).toHaveLength(0);
    const actions = (await repo.listTraces(company.id)).map((trace) => trace.action);
    expect(actions.filter((a) => a === 'whatsapp.reaction')).toHaveLength(2);
    expect(actions).toEqual(
      expect.arrayContaining(['whatsapp.system', 'whatsapp.request_welcome']),
    );
    const traces = JSON.stringify(await repo.listTraces(company.id));
    expect(traces).not.toContain('👍');
    expect(traces).not.toContain(customer);
    const saved = await repo.getConversation(company.id, conversation.id);
    expect(saved?.lastInboundAt).toBe(conversation.lastInboundAt);
    expect(saved?.mode).toBe('bot');
  });

  it('keeps captions, locations and buttons in the chat with the bot still answering', async () => {
    await webhook({
      messages: [
        message('wamid.c1', { type: 'image', image: { id: 'm1', caption: '2 biryani please' } }),
      ],
    });
    await webhook({
      messages: [
        message('wamid.l1', {
          type: 'location',
          location: { latitude: 31.5204, longitude: 74.3587, address: 'Gulberg III' },
        }),
      ],
    });
    await webhook({
      messages: [message('wamid.b1', { type: 'button', button: { text: 'Menu', payload: 'x' } })],
    });
    const jobs = await incoming();
    expect(
      jobs.map((job) => [job.payload.messageId, job.payload.text, job.payload.action]),
    ).toEqual([
      ['wamid.b1', 'Menu', undefined],
      ['wamid.c1', '2 biryani please (sent with a photo)', undefined],
      ['wamid.l1', 'Location shared: Gulberg III (31.5204, 74.3587)', undefined],
    ]);
    await drain();
    for (const job of jobs) expect((await repo.getJob(job.id))?.status).toBe('done');
    const conversation = await chat();
    expect(conversation.mode).toBe('bot');
    expect(conversation.botPausedAt).toBeUndefined();
    expect(
      conversation.messages
        .filter((m) => m.role === 'customer')
        .map((m) => m.text)
        .sort(),
    ).toEqual([
      '2 biryani please (sent with a photo)',
      'Location shared: Gulberg III (31.5204, 74.3587)',
      'Menu',
    ]);
  });

  it('still hands voice notes, stickers and uncaptioned photos to staff', async () => {
    await webhook({
      messages: [
        message('wamid.a1', { type: 'audio', audio: { id: 'v' } }),
        message('wamid.k1', { type: 'sticker', sticker: { id: 'k' } }),
        message('wamid.p1', { type: 'image', image: { id: 'p' } }),
      ],
    });
    const jobs = await incoming();
    expect(jobs).toHaveLength(3);
    for (const job of jobs)
      expect(job.payload).toMatchObject({ text: MEDIA_HANDOFF_TEXT, action: { type: 'handoff' } });
    await drain();
    expect((await chat()).mode).toBe('human');
  });

  it('does not pause the bot when staff react from the WhatsApp Business app', async () => {
    const conversation = createConversation(
      company.id,
      customer,
      'whatsapp',
      new Date().toISOString(),
    );
    conversation.version = 1;
    await repo.saveConversation(conversation, 0);
    await webhook(
      {
        message_echoes: [
          { id: 'wamid.e1', to: customer, type: 'reaction', reaction: { emoji: '👍' } },
        ],
      },
      'smb_message_echoes',
    );
    expect(await incoming()).toHaveLength(0);
    expect((await repo.getConversation(company.id, conversation.id))?.mode).toBe('bot');
    // A real staff message from the app still takes the chat over, as before.
    await webhook(
      { message_echoes: [{ id: 'wamid.e2', to: customer, type: 'text', text: { body: 'Hi' } }] },
      'smb_message_echoes',
    );
    const [job] = await incoming();
    expect(job.payload).toMatchObject({ echo: true, text: 'Hi' });
  });
});
