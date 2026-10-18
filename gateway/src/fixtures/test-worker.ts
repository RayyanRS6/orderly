// Socket-free child used exclusively by supervisor integration tests.
import { appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let connectionId = '';
let generation = 0;
process.on('message', (message: any) => {
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
    process.send?.({
      type: 'result',
      requestId: message.requestId,
      result: { messageId: `test:${message.body.idempotencyKey}` },
    });
  }
  if (message.type === 'stop') {
    // Lets tests see whether a stop asked to log the linked device out, and that the session's
    // credentials were still there at that moment (row metadata is not encrypted).
    const log = process.env.ORDERLY_TEST_STOP_LOG;
    if (log) {
      const path = join(dirname(log), `${connectionId}.sqlite`);
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
      appendFileSync(log, `${connectionId} ${message.logout} ${auth}\n`);
    }
    process.exit(0);
  }
});
