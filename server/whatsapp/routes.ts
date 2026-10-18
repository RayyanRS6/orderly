import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../management';
import type { Repository } from '../repository';
import type { Company } from '../../src/shared/types';
import type { WhatsAppConnection } from '../../src/shared/whatsapp';
import { PublicError } from '../security';
import { gatewayAvailable, gatewayRequest, gatewaySnapshotSchema } from './client';
import {
  LINKED_DEVICE_CONSENT_VERSION,
  disconnectGateway,
  selectMeta,
  startPairing,
  withConnectionLock,
} from './connections';

// A new linked-phone pairing needs the Orderly admin's approval for this business. A business
// already on a linked phone keeps it, and every other action on its connection stays open.
const pairingAllowed = (company: Company, connection?: WhatsAppConnection) =>
  !!company.linkedDeviceAllowed || connection?.provider === 'baileys';

export function whatsappRoutes(repo: Repository) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    if (c.get('role') === 'staff')
      throw new PublicError('Only an owner can manage WhatsApp connections.', 403);
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/connection', async (c) => {
    const connection = await repo.getWhatsAppConnection(c.get('company').id);
    const allowed = pairingAllowed(c.get('company'), connection);
    return c.json({
      // Dashboards from before the approval show the linked-phone controls only when true.
      enabled: gatewayAvailable() && allowed,
      gatewayEnabled: gatewayAvailable(),
      pairingAllowed: allowed,
      consentVersion: LINKED_DEVICE_CONSENT_VERSION,
      connection: connection ?? null,
    });
  });
  app.post('/pair', async (c) => {
    const body = z
      .object({
        method: z.enum(['qr', 'code']),
        phone: z
          .string()
          .regex(/^[1-9]\d{5,14}$/)
          .optional(),
        riskAccepted: z.literal(true),
        switchConfirmed: z.literal(true),
        consent: z
          .object({ version: z.string().max(80), accepted: z.literal(true) })
          .strict()
          .optional(),
      })
      .strict()
      .parse(await c.req.json());
    // A page open from before the current risk notice must show it before pairing.
    if (body.consent?.version !== LINKED_DEVICE_CONSENT_VERSION)
      throw new PublicError('Please reload the page to continue.', 400);
    if (body.method === 'code' && !body.phone)
      throw new PublicError('Enter your number including country code.', 400);
    const company = c.get('company');
    if (!pairingAllowed(company, await repo.getWhatsAppConnection(company.id)))
      throw new PublicError(
        'Linked-phone pairing needs approval from Orderly support. Use the official WhatsApp Business Platform instead.',
        403,
      );
    if (!(await repo.consumeRateLimit(`wa-pair:${company.id}`, 3)))
      throw new PublicError('Too many pairing attempts. Wait a minute.', 429);
    const consent = {
      userId: c.get('userId'),
      at: new Date().toISOString(),
      version: LINKED_DEVICE_CONSENT_VERSION,
    };
    // Recorded before pairing starts: the owner accepted the notice whatever happens next.
    await repo.audit(
      company.id,
      consent.userId,
      `whatsapp.linked_risk_accepted ${consent.version}`,
    );
    return c.json(await startPairing(repo, company.id, body.method, body.phone, consent));
  });
  app.post('/pairing-status', async (c) => {
    const current = await repo.getWhatsAppConnection(c.get('company').id);
    if (!current || current.provider !== 'baileys')
      throw new PublicError('No linked-device connection.', 409);
    const snapshot = gatewaySnapshotSchema.parse(
      await gatewayRequest('/status', { connectionId: current.id, generation: current.generation }),
    );
    return c.json({ connection: current, snapshot });
  });
  app.post('/reconnect', async (c) =>
    c.json(
      await withConnectionLock(repo, c.get('company').id, async () => {
        const current = await repo.getWhatsAppConnection(c.get('company').id);
        if (
          !current ||
          current.provider !== 'baileys' ||
          ['logged_out', 'disconnected'].includes(current.status)
        )
          throw new PublicError('Start a new pairing first.', 409);
        return gatewaySnapshotSchema.parse(
          await gatewayRequest('/session', {
            connectionId: current.id,
            generation: current.generation,
            action: 'reconnect',
          }),
        );
      }),
    ),
  );
  // gatewayCleanupPending: the switch is saved, but the old session could not be ended on the
  // gateway; the owner should remove Orderly under WhatsApp → Linked devices on the phone.
  app.post('/disconnect', async (c) => {
    z.object({ confirmed: z.literal(true) }).parse(await c.req.json());
    const { gatewayCleanupPending } = await disconnectGateway(repo, c.get('company').id);
    return c.json({ ok: true, ...(gatewayCleanupPending && { gatewayCleanupPending }) });
  });
  app.post('/select-meta', async (c) => {
    z.object({ confirmed: z.literal(true) }).parse(await c.req.json());
    const result = await selectMeta(repo, c.get('company').id);
    if (!result) return c.json({ connection: null });
    const { gatewayCleanupPending, ...connection } = result;
    return c.json({ connection, ...(gatewayCleanupPending && { gatewayCleanupPending }) });
  });
  return app;
}
