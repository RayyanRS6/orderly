import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../server/repository';
import { saveConnection } from '../server/whatsapp/connections';
import { readiness } from '../server/readiness';
import { buildAgentFlow } from '../server/agent-flow';
import { LinkedWhatsAppAdapter } from '../server/integrations/linked-whatsapp';
import { createConversation } from '../src/domain/engine';
import { seedCompanies } from '../src/shared/seed';
import {
  GATEWAY_HEARTBEAT_MS,
  GATEWAY_HEARTBEAT_STALE_MS,
  type WhatsAppConnection,
} from '../src/shared/whatsapp';

// F06: the linked phone reports once a minute instead of every 15 s, so Orderly must not
// treat it as offline until three reports in a row are missing.
const company = seedCompanies[0];
let repo: MemoryRepository;
let connection: WhatsAppConnection;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
beforeEach(async () => {
  vi.stubEnv('APP_MODE', 'live');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('WHATSAPP_GATEWAY_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_GATEWAY_URL', 'https://gateway.example');
  vi.stubEnv('WHATSAPP_GATEWAY_SECRET', 'gateway-test-secret-with-more-than-32-characters');
  repo = new MemoryRepository();
  connection = {
    id: randomUUID(),
    companyId: company.id,
    provider: 'baileys',
    generation: 1,
    revision: 1,
    status: 'connected',
    accountJid: '923000000001@s.whatsapp.net',
    lastHeartbeatAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await repo.saveWhatsAppConnection(connection, 0);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const whatsappReady = async () =>
  (await readiness(repo, company)).find((c) => c.id === 'whatsapp')?.ready;
async function heartbeat(age: number) {
  connection = await saveConnection(repo, { ...connection, lastHeartbeatAt: ago(age) });
}

describe('linked-phone heartbeat staleness', () => {
  it('allows three missed one-minute heartbeats before treating the phone as offline', () => {
    expect(GATEWAY_HEARTBEAT_MS).toBeGreaterThanOrEqual(45000);
    expect(GATEWAY_HEARTBEAT_STALE_MS).toBeGreaterThanOrEqual(3 * GATEWAY_HEARTBEAT_MS);
  });

  it('keeps launch readiness through two late heartbeats and drops it after the limit', async () => {
    await heartbeat(2.5 * 60000);
    expect(await whatsappReady()).toBe(true);
    await heartbeat(GATEWAY_HEARTBEAT_STALE_MS + 5000);
    expect(await whatsappReady()).toBe(false);
  });

  it('still sends a reply when the last heartbeat is 150 seconds old, and refuses after the limit', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ messageId: 'wamid-sent' }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetch);
    const conversation = {
      ...createConversation(company.id, '', 'whatsapp', new Date().toISOString()),
      whatsappAddress: {
        connectionId: connection.id,
        generation: 1,
        provider: 'baileys' as const,
        peer: '100000001@lid',
      },
    };
    const adapter = new LinkedWhatsAppAdapter(repo, company.id, 'job-heartbeat');
    await heartbeat(150000);
    await expect(adapter.send(conversation, 'hello')).resolves.toBe('wamid-sent');
    await heartbeat(GATEWAY_HEARTBEAT_STALE_MS + 5000);
    await expect(adapter.send(conversation, 'hello')).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shows a two-minute-old heartbeat as fine on Agent flow and a stale one as a warning', async () => {
    const tone = async () => {
      const flow = await buildAgentFlow(repo, (await repo.getCompany(company.id))!, 'owner');
      return flow.nodes
        .find((n) => n.id === 'channel')!
        .facts.find((f) => f.label === 'Last heartbeat')?.tone;
    };
    await heartbeat(120000);
    expect(await tone()).toBe('ok');
    await heartbeat(GATEWAY_HEARTBEAT_STALE_MS + 5000);
    expect(await tone()).toBe('warn');
  });
});
