// Socket-free child used exclusively by supervisor integration tests.
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
  if (message.type === 'stop') process.exit(0);
});
