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
    process.send?.({
      type: 'result',
      requestId: message.requestId,
      result: { messageId: `test:${message.body.idempotencyKey}` },
    });
  }
  if (message.type === 'stop') process.exit(0);
});
