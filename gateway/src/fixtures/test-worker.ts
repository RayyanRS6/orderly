// Socket-free child used exclusively by supervisor integration tests.
import { appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let connectionId = '';
let generation = 0;
// Lets tests see a stop or logout, and whether the session's credentials were still there at
// that moment (row metadata is not encrypted).
function record(id: string, what: string) {
  const log = process.env.ORDERLY_TEST_STOP_LOG;
  if (!log) return;
  const path = join(dirname(log), `${id}.sqlite`);
  let auth = 0;
  if (existsSync(path)) {
    const db = new DatabaseSync(path);
    auth = Number(
      (
        db.prepare("SELECT count(*) AS n FROM records WHERE namespace='auth'").get() as {
          n: number;
        }
      ).n,
    );
    db.close();
  }
  appendFileSync(log, `${id} ${what} ${auth}\n`);
}
process.on('message', (message: any) => {
  // The short-lived worker that only logs out a session with no running worker.
  if (message.type === 'logout') {
    record(message.connectionId, 'logout-only');
    process.exit(0);
  }
  if (message.type === 'init') {
    connectionId = message.connectionId;
    generation = message.generation;
    process.send?.({
      type: 'snapshot',
      snapshot: { connectionId, generation, status: 'connected' },
    });
  }
  if (message.type === 'send') {
    if (message.body.text === 'simulate-crash') process.exit(1);
    // A worker that reports why it stops, as fail() does.
    if (message.body.text === 'simulate-fatal') {
      process.send?.({ type: 'fatal', errorCode: 'INBOUND_QUEUE_FULL' }, undefined, {}, () =>
        process.exit(1),
      );
      return;
    }
    // A pairing nobody finished ends, as the real worker's fail('PAIRING_EXPIRED') does.
    if (message.body.text === 'simulate-pairing-expired') {
      process.send?.({ type: 'fatal', errorCode: 'PAIRING_EXPIRED' }, undefined, {}, () =>
        process.exit(1),
      );
      return;
    }
    // WhatsApp refused a pairing nobody finished (a stop code): the real worker reports it as its
    // status and ends with the same code, which the 5-minute timer no longer replaces.
    if (message.body.text === 'simulate-refused') {
      process.send?.({
        type: 'snapshot',
        snapshot: { connectionId, generation, status: 'error', errorCode: 'DISCONNECT_405' },
      });
      process.send?.({ type: 'fatal', errorCode: 'DISCONNECT_405' }, undefined, {}, () =>
        process.exit(1),
      );
      return;
    }
    // Orderly answered an event with 410: it no longer uses this session.
    if (message.body.text === 'simulate-stale') process.send?.({ type: 'stale' });
    process.send?.({
      type: 'result',
      requestId: message.requestId,
      result: { messageId: `test:${message.body.idempotencyKey}` },
    });
  }
  if (message.type === 'stop') {
    // Whether a stop asked to log the linked device out.
    record(connectionId, String(message.logout));
    process.exit(0);
  }
});
