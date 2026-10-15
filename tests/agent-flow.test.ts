import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { buildAgentFlow } from '../server/agent-flow';
import { handleTurn } from '../server/service';
import { encryptSecret } from '../server/security';
import { modelFingerprint } from '../server/integrations/model-catalog';
import { createConversation } from '../src/domain/engine';
import { generationProfile } from '../src/shared/models';
import { seedCompanies, seedConversations, seedOrders, seedProducts } from '../src/shared/seed';
import type { AgentFlow as Flow, FlowNode, FlowNodeId } from '../src/shared/agent-flow';
import type { Bootstrap, Company } from '../src/shared/types';
import { AgentFlow } from '../src/components/AgentFlow';
import { Workspace, type WorkspaceContext } from '../src/lib/workspace';
import { parseRoute, workspacePath } from '../src/lib/routes';

const company = seedCompanies[0]!;
const nodeIds: FlowNodeId[] = [
  'channel',
  'sandbox',
  'gates',
  'agent',
  'model',
  'memory',
  'menu',
  'knowledge',
  'instructions',
  'engine',
  'router',
  'reply',
  'order',
  'sheets',
  'staff',
];
const platformSecret = 'sk-test-secret-value';
const businessSecret = 'sk-business-secret-value';
let repo: MemoryRepository;

beforeEach(() => {
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  for (const name of [
    'MODEL_PRICING_JSON',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_API_KEY',
    'RESEND_API_KEY',
    'ALERT_FROM_EMAIL',
  ])
    vi.stubEnv(name, '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const node = (flow: Flow, id: FlowNodeId): FlowNode => flow.nodes.find((item) => item.id === id)!;
const fact = (item: FlowNode, label: string) => item.facts.find((f) => f.label === label)?.value;
const step = (flow: Flow, id: string) => flow.setup.find((item) => item.id === id)!;
const current = async () => (await repo.getCompany(company.id))!;
async function useHaiku(keyMode: 'own' | 'platform', extra: Partial<Company> = {}) {
  await repo.saveCompany({
    ...(await current()),
    ai: { provider: 'anthropic', model: 'claude-haiku-5-5', keyMode, monthlyBudgetUsd: 10 },
    ...extra,
  });
  return current();
}

describe('buildAgentFlow', () => {
  it('maps every connected part of the demo business', async () => {
    const flow = await buildAgentFlow(repo, await current(), 'owner');
    expect(flow.mode).toBe('demo');
    expect(flow.nodes.map((item) => item.id)).toEqual(nodeIds);
    expect(new Set(flow.nodes.map((item) => item.id)).size).toBe(15);
    expect(Number.isFinite(Date.parse(flow.generatedAt))).toBe(true);
    expect(node(flow, 'menu').subtitle).toBe('7 of 8 items available');
    expect(node(flow, 'engine')).toMatchObject({ status: 'fixed', editable: false });
  });

  it('separates required, recommended and demo-only setup steps', async () => {
    const flow = await buildAgentFlow(repo, await current(), 'owner');
    // Demo sample orders are fixtures and must not tick "Place a test order".
    expect(step(flow, 'try')).toMatchObject({ done: false, recommended: true });
    expect(fact(node(flow, 'sandbox'), 'Test orders so far')).toBe('0');
    expect(step(flow, 'business').recommended).toBe(true);
    expect(step(flow, 'whatsapp').optional).toBe(true);
    expect(step(flow, 'model').recommended).toBeUndefined();
    expect(step(flow, 'model').optional).toBeUndefined();
  });

  it('asks for a model while the business still uses local rules', async () => {
    const flow = await buildAgentFlow(repo, await current(), 'owner');
    expect(node(flow, 'model')).toMatchObject({
      title: 'No AI model',
      subtitle: 'Local rules only',
      status: 'attention',
      statusLabel: 'Not selected',
      todo: 'Choose an AI provider and model in Bot settings.',
    });
    expect(node(flow, 'agent').status).toBe('attention');
    expect(step(flow, 'model').done).toBe(false);
    expect(step(flow, 'key').done).toBe(false);
  });

  it('describes Claude Haiku 5.5 with its prices and the missing business key', async () => {
    const flow = await buildAgentFlow(repo, await useHaiku('own'), 'owner');
    const model = node(flow, 'model');
    expect(model).toMatchObject({
      title: 'Anthropic',
      subtitle: 'claude-haiku-5-5',
      status: 'attention',
      statusLabel: 'Needs setup',
    });
    expect(fact(model, 'Price per 1M tokens')).toBe('$0.10 in · $0.50 out');
    expect(fact(model, 'API key available')).toBe('No');
    expect(fact(model, 'Who pays')).toBe('This business’s API key');
    expect(fact(model, 'Thinking')).toBe(
      generationProfile('anthropic', 'claude-haiku-5-5').summary,
    );
    expect(model.todo).toBe('Save this business’s Anthropic API key in Integrations.');
    expect(fact(node(flow, 'agent'), 'Model')).toBe('Anthropic · claude-haiku-5-5');
    expect(step(flow, 'model').done).toBe(true);
    expect(step(flow, 'key')).toMatchObject({ done: false, page: 'integrations' });
  });

  it('marks a tested model ready without exposing the platform key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', platformSecret);
    const selected = await useHaiku('platform', {
      privacy: { aiDataApproved: true, retentionDays: 0 },
    });
    const verified = await useHaiku('platform', {
      privacy: { aiDataApproved: true, retentionDays: 0 },
      modelVerification: {
        fingerprint: modelFingerprint(selected, platformSecret),
        checkedAt: new Date().toISOString(),
      },
    });
    const flow = await buildAgentFlow(repo, verified, 'owner');
    const model = node(flow, 'model');
    expect(model).toMatchObject({ status: 'ready', statusLabel: 'Tested' });
    expect(model.todo).toBeUndefined();
    expect(fact(model, 'API key available')).toBe('Yes');
    expect(fact(model, 'Generation test')).toBe('Passed for this exact model and key');
    expect(fact(model, 'Who pays')).toBe('Orderly platform key');
    expect(step(flow, 'test').done).toBe(true);
    expect(flow.platform?.find((check) => check.id === 'anthropic')?.ok).toBe(true);
    expect(JSON.stringify(flow)).not.toContain(platformSecret);
  });

  it('never exposes a saved business key or its encrypted form', async () => {
    const encrypted = encryptSecret(businessSecret);
    await repo.saveIntegration(
      company.id,
      { kind: 'anthropic', configured: true, status: 'connected', config: {} },
      encrypted,
    );
    const flow = await buildAgentFlow(repo, await useHaiku('own'), 'owner');
    expect(fact(node(flow, 'model'), 'API key available')).toBe('Yes');
    expect(step(flow, 'key').done).toBe(true);
    const serialized = JSON.stringify(flow);
    expect(serialized).not.toContain(businessSecret);
    expect(serialized).not.toContain(encrypted);
  });

  it('shows server checks to owners and administrators but not to staff', async () => {
    const target = await current();
    const staff = await buildAgentFlow(repo, target, 'staff');
    expect('platform' in staff).toBe(false);
    for (const role of ['owner', 'admin'] as const) {
      const flow = await buildAgentFlow(repo, target, role);
      expect(flow.platform?.map((check) => check.id)).toEqual([
        'mode',
        'anthropic',
        'openai',
        'gemini',
        'gateway',
        'meta',
        'worker',
        'encryption',
        'email',
      ]);
      expect(flow.platform?.[0]).toMatchObject({ ok: true, detail: 'Local demo: nothing is sent' });
      expect(flow.platform?.find((check) => check.id === 'anthropic')?.ok).toBe(false);
    }
  });

  it('lists the latest explained replies after turns are handled', async () => {
    const before = await buildAgentFlow(repo, await current(), 'owner');
    expect(before.recent).toEqual([]);
    const tap = async (phone: string, at: string) => {
      const messageId = randomUUID();
      const result = await handleTurn(
        repo,
        await current(),
        createConversation(company.id, phone, 'demo', at),
        { messageId, text: 'menu', action: { type: 'menu' }, now: at },
      );
      return { messageId, result };
    };
    const older = await tap('923001234001', new Date(Date.now() - 60_000).toISOString());
    const newer = await tap('923001234002', new Date().toISOString());
    const flow = await buildAgentFlow(repo, await current(), 'owner');
    expect(flow.recent.map((item) => item.message.id)).toEqual([
      `${newer.messageId}:reply`,
      `${older.messageId}:reply`,
    ]);
    expect(flow.recent[0]).toMatchObject({
      conversationId: newer.result.conversation.id,
      channel: 'demo',
      message: { text: newer.result.reply, explanation: newer.result.explanation },
    });
    expect(flow.recent[0]!.message.explanation?.ai).toEqual({ called: false, skipped: 'button' });
  });
});

describe('GET /api/agent-flow', () => {
  const request = (url: string) =>
    createApp(repo).request(url, {
      headers: { 'x-company-id': company.id, Origin: 'http://127.0.0.1:5173' },
    });

  it('returns the flow for the selected demo business', async () => {
    const response = await request('http://127.0.0.1:4000/api/agent-flow');
    expect(response.status).toBe(200);
    const flow = (await response.json()) as Flow;
    expect(flow.mode).toBe('demo');
    expect(flow.nodes.map((item) => item.id)).toEqual(nodeIds);
    expect(flow.setup.length).toBeGreaterThan(0);
    expect(flow.platform?.length).toBeGreaterThan(0);
  });

  it('keeps demo access restricted to this computer', async () => {
    expect((await request('http://example.com/api/agent-flow')).status).toBe(403);
  });
});

function bootstrap(overrides: Partial<Bootstrap> = {}): Bootstrap {
  return {
    mode: 'demo',
    role: 'owner',
    company,
    companies: seedCompanies,
    products: seedProducts,
    orders: seedOrders,
    conversations: seedConversations,
    integrations: [],
    aiConnection: { provider: 'mock', keyMode: 'platform', configured: true },
    usage: [],
    traces: [],
    ...overrides,
  };
}
function workspace(data: Bootstrap): WorkspaceContext {
  return {
    data,
    busy: false,
    error: '',
    clearError: () => {},
    page: 'flow',
    navigate: () => {},
    switchCompany: () => {},
    refresh: async () => {},
    mutate: async <T>() => ({}) as T,
  };
}

describe('Agent flow page', () => {
  it.each([
    ['seed data', bootstrap()],
    ['minimal data', bootstrap({ products: [], orders: [], conversations: [], companies: [] })],
  ])('renders the heading and loading state with %s', (_label, data) => {
    const html = renderToStaticMarkup(
      createElement(Workspace.Provider, { value: workspace(data) }, createElement(AgentFlow)),
    );
    expect(html).toContain('Agent flow');
    expect(html).toContain('How a customer message flows');
    expect(html).toContain('Loading your bot’s connections…');
    expect(html).not.toContain('Get this business live');
  });

  it('accepts the flow page as a workspace route', () => {
    expect(workspacePath('some-slug', 'flow')).toBe('/app/some-slug/flow');
    expect(parseRoute('/app/some-slug/flow')).toMatchObject({
      slug: 'some-slug',
      page: 'flow',
      valid: true,
    });
    expect(parseRoute('/app/some-slug/flow').id).toBeUndefined();
    expect(parseRoute('/app/some-slug/flow/extra').valid).toBe(false);
  });
});
