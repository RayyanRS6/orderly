import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../management';
import type { Repository } from '../repository';
import { PublicError } from '../security';
import { gatewayAvailable, gatewayRequest, gatewaySnapshotSchema } from './client';
import { disconnectGateway, selectMeta, startPairing, withConnectionLock } from './connections';

export function whatsappRoutes(repo: Repository) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    if (c.get('role') === 'staff')
      throw new PublicError('Only an owner can manage WhatsApp connections.', 403);
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/connection', async (c) =>
    c.json({
      enabled: gatewayAvailable(),
      connection: (await repo.getWhatsAppConnection(c.get('company').id)) ?? null,
    }),
  );
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
      })
      .strict()
      .parse(await c.req.json());
    if (body.method === 'code' && !body.phone)
      throw new PublicError('Enter your number including country code.', 400);
    if (!(await repo.consumeRateLimit(`wa-pair:${c.get('company').id}`, 3)))
      throw new PublicError('Too many pairing attempts. Wait a minute.', 429);
    return c.json(await startPairing(repo, c.get('company').id, body.method, body.phone));
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
  app.post('/disconnect', async (c) => {
    z.object({ confirmed: z.literal(true) }).parse(await c.req.json());
    await disconnectGateway(repo, c.get('company').id);
    return c.json({ ok: true });
  });
  app.post('/select-meta', async (c) => {
    z.object({ confirmed: z.literal(true) }).parse(await c.req.json());
    return c.json({ connection: (await selectMeta(repo, c.get('company').id)) ?? null });
  });
  return app;
}
