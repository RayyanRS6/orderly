// Staff alerts for a linked phone that stopped working (F04): when the gateway reports it down,
// and the local store's alert rule, which mirrors the database's.
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { receiveGatewayEvent } from '../server/whatsapp/connections';
import type { GatewayEvent } from '../src/shared/whatsapp';
import { company, demoApp, linkedPhone, minutesAgo, storeConnection } from './helpers/demo-app';

const app = demoApp();

describe('when a linked phone stopped working (F04)', () => {
  const event = (fields: Partial<GatewayEvent>): GatewayEvent => ({
    eventId: randomUUID(),
    connectionId: linkedPhone().id,
    generation: 1,
    type: 'status',
    timestamp: new Date().toISOString(),
    ...fields,
  });
  const downSince = async () =>
    ((await app.repo().getWhatsAppConnection(company.id)) as { downSince?: string } | undefined)
      ?.downSince;

  it('records when the phone stopped being connected, until it is connected again', async () => {
    const repo = app.repo();
    await storeConnection(repo, { status: 'connected', lastHeartbeatAt: minutesAgo(10) });
    const accountJid = linkedPhone().accountJid;
    await receiveGatewayEvent(
      repo,
      event({ status: 'connected', accountJid, timestamp: minutesAgo(9) }),
    );
    expect(await downSince()).toBeUndefined();
    const lost = minutesAgo(8);
    await receiveGatewayEvent(repo, event({ status: 'reconnecting', timestamp: lost }));
    expect(await downSince()).toBe(lost);
    // Every attempt refreshes the heartbeat, but not when it went down.
    await receiveGatewayEvent(repo, event({ status: 'reconnecting', timestamp: minutesAgo(5) }));
    const lastTry = minutesAgo(4);
    await receiveGatewayEvent(repo, event({ status: 'connecting', timestamp: lastTry }));
    expect(await downSince()).toBe(lost);
    expect((await repo.getWhatsAppConnection(company.id))!.lastHeartbeatAt).toBe(lastTry);
    await receiveGatewayEvent(
      repo,
      event({ status: 'connected', accountJid, timestamp: minutesAgo(1) }),
    );
    expect(await downSince()).toBeUndefined();
  });

  it('alerts staff in the bell and by email, by the same rule as the database', async () => {
    const repo = app.repo();
    const items = async () =>
      (await repo.staffAttention(company.id)).items.filter((a) => a.kind === 'whatsapp');
    const overdue = (minutes: number) => repo.hasOverdueAttention(company.id, minutes);
    const id = linkedPhone().id;

    await storeConnection(repo, { status: 'connected' });
    expect(await items()).toEqual([]);
    expect(await overdue(120)).toBe(false);

    // Connected, but silent past the heartbeat limit: the gateway is gone.
    const beat = minutesAgo(4);
    await storeConnection(repo, { status: 'connected', lastHeartbeatAt: beat });
    expect(await items()).toEqual([
      { id: `whatsapp:${id}`, kind: 'whatsapp', entityId: id, createdAt: beat },
    ]);
    expect(await repo.staffAttention(company.id)).toMatchObject({ whatsapp: 1, total: 1 });
    expect(await overdue(120)).toBe(true);

    // Reconnecting: the bell after 3 minutes, email after the alert delay.
    await storeConnection(repo, { status: 'reconnecting', downSince: minutesAgo(2) });
    expect(await items()).toEqual([]);
    const since = minutesAgo(12);
    await storeConnection(repo, { status: 'reconnecting', downSince: since });
    expect((await items()).map((a) => a.createdAt)).toEqual([since]);
    expect(await overdue(10)).toBe(true);
    expect(await overdue(15)).toBe(false);
    // Saved before downSince existed: when it last changed.
    await storeConnection(repo, { status: 'connecting', updatedAt: minutesAgo(20) });
    expect(await overdue(15)).toBe(true);

    // Logged out or failed: at once.
    for (const status of ['logged_out', 'error'] as const) {
      await storeConnection(repo, { status, updatedAt: new Date().toISOString() });
      expect((await items()).length, status).toBe(1);
      expect(await overdue(120), status).toBe(true);
    }

    // Not an alert: a pairing in progress, the official route, or a bot switched off.
    await storeConnection(repo, { status: 'error', accountJid: undefined });
    expect(await items()).toEqual([]);
    await storeConnection(repo, { status: 'error', provider: 'meta' });
    expect(await items()).toEqual([]);
    await storeConnection(repo, { status: 'logged_out' });
    await repo.saveCompany({ ...company, botEnabled: false });
    expect(await items()).toEqual([]);
    expect(await overdue(5)).toBe(false);
  });
});
