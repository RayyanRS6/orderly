// Linked-phone gateway fix (fx-3): a message the linked device could not read is worded as such
// for staff, and its real copy still gets through when it comes later.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../server/repository';
import { receiveGatewayEvent } from '../server/whatsapp/connections';
import { MEDIA_HANDOFF_TEXT } from '../server/whatsapp/inbound';
import { gatewayEventSchema, type WhatsAppConnection } from '../src/shared/whatsapp';
import { seedCompanies } from '../src/shared/seed';

const company = seedCompanies[0];
const secret = 'gateway-test-secret-with-more-than-32-characters';
let repo: MemoryRepository;
let connection: WhatsAppConnection;
beforeEach(async () => {
  vi.stubEnv('APP_MODE', 'live');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('WHATSAPP_GATEWAY_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_GATEWAY_URL', 'https://gateway.example');
  vi.stubEnv('WHATSAPP_GATEWAY_SECRET', secret);
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
function event(overrides: Record<string, unknown> = {}) {
  return gatewayEventSchema.parse({
    eventId: randomUUID(),
    connectionId: connection.id,
    generation: 1,
    type: 'message',
    peer: '100000001@lid',
    messageId: 'wamid-one',
    text: 'menu',
    fromMe: false,
    timestamp: new Date().toISOString(),
    ...overrides,
  });
}

describe('a customer message the linked device could not read', () => {
  it('is worded as unreadable for staff, and the real copy still gets through later', async () => {
    await receiveGatewayEvent(
      repo,
      event({ messageId: 'lost:unread', text: '', unsupported: true }),
    );
    const [notice] = await repo.listCompanyJobs(company.id);
    expect(notice.payload.text).toBe(
      'Customer sent a message Orderly could not read on the linked phone. Check the restaurant phone. Staff assistance requested.',
    );
    expect(notice.payload.action).toEqual({ type: 'handoff' });
    expect(notice.payload.messageId).toBe('lost:unread');
    // The sender's retry arrives after staff were told: a job of its own, not a duplicate.
    await receiveGatewayEvent(repo, event({ messageId: 'lost', text: 'menu' }));
    const jobs = await repo.listCompanyJobs(company.id);
    expect(jobs).toHaveLength(2);
    expect(jobs.find((job) => job.payload.messageId === 'lost')?.payload.text).toBe('menu');
    // Real media keeps its own wording.
    await receiveGatewayEvent(repo, event({ messageId: 'voice', text: '', unsupported: true }));
    expect(
      (await repo.listCompanyJobs(company.id)).find((job) => job.payload.messageId === 'voice')
        ?.payload.text,
    ).toBe(MEDIA_HANDOFF_TEXT);
  });
});
