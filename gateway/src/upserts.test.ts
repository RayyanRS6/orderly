import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { makeEventBuffer, proto, type WAMessage } from '@whiskeysockets/baileys';
import { chatContent, receiptStatus, upsertedMessages } from './upserts.js';

const message = (id: string, fromMe: boolean): WAMessage => ({
  key: { remoteJid: '100000001@lid', id, fromMe },
  message: { conversation: fromMe ? 'Here is our menu.' : 'menu' },
  messageTimestamp: Math.floor(Date.now() / 1000),
  status: fromMe ? proto.WebMessageInfo.Status.PENDING : undefined,
});
function capture() {
  const ev = makeEventBuffer(pino({ level: 'silent' }));
  const upserts: { messages: WAMessage[]; type: string; requestId?: string }[] = [];
  const updates: unknown[] = [];
  ev.on('messages.upsert', (update) => upserts.push(update));
  ev.on('messages.update', (update) => updates.push(update));
  return { ev, upserts, updates };
}

test('a customer message batched behind our own reply is still handed on', () => {
  const { ev, upserts } = capture();
  // Sending a reply upserts it as 'append' and leaves Baileys buffering.
  ev.buffer();
  ev.emit('messages.upsert', { messages: [message('reply', true)], type: 'append' });
  ev.emit('messages.upsert', { messages: [message('customer', false)], type: 'notify' });
  ev.flush();
  assert.equal(upserts.length, 1);
  // The library labels the whole batch by its first message: the customer's is 'append'.
  assert.equal(upserts[0]!.type, 'append');
  const ids = upsertedMessages(upserts[0]!).map((m) => m.key.id);
  assert.deepEqual(ids, ['reply', 'customer']);
});

test('a delivery tick folded into our reply upsert is still read', () => {
  const { ev, upserts, updates } = capture();
  ev.buffer();
  ev.emit('messages.upsert', { messages: [message('reply', true)], type: 'append' });
  ev.emit('messages.update', [
    {
      key: { remoteJid: '100000001@lid', id: 'reply', fromMe: true },
      update: { status: proto.WebMessageInfo.Status.DELIVERY_ACK },
    },
  ]);
  ev.flush();
  assert.equal(updates.length, 0);
  const [reply] = upsertedMessages(upserts[0]!);
  assert.equal(receiptStatus(reply!.status), 'delivered');
});

test('maps only delivered, read and played ticks; skips placeholder resends', () => {
  const { Status } = proto.WebMessageInfo;
  assert.equal(receiptStatus(Status.PENDING), undefined);
  assert.equal(receiptStatus(Status.SERVER_ACK), undefined);
  assert.equal(receiptStatus(Status.DELIVERY_ACK), 'delivered');
  assert.equal(receiptStatus(Status.READ), 'read');
  assert.equal(receiptStatus(Status.PLAYED), 'read');
  assert.equal(receiptStatus(undefined), undefined);
  assert.deepEqual(upsertedMessages({ messages: [message('x', false)], requestId: 'r' }), []);
});

test('an edit, deletion, reaction or pin is not a new customer message', () => {
  const { Type } = proto.Message.ProtocolMessage;
  const edit = {
    editedMessage: {
      message: {
        protocolMessage: { type: Type.MESSAGE_EDIT, editedMessage: { conversation: '3' } },
      },
    },
  };
  assert.equal(chatContent(edit), undefined);
  assert.equal(
    chatContent({ ephemeralMessage: { message: { reactionMessage: { text: '👍' } } } }),
    undefined,
  );
  assert.equal(chatContent({ protocolMessage: { type: Type.REVOKE } }), undefined);
  assert.equal(chatContent({ pinInChatMessage: {} }), undefined);
  assert.equal(chatContent(undefined), undefined);
  // Ordinary text, also inside a disappearing-messages wrapper, is kept.
  assert.equal(chatContent({ conversation: '2 biryani' })?.conversation, '2 biryani');
  const wrapped = { ephemeralMessage: { message: { extendedTextMessage: { text: 'menu' } } } };
  assert.equal(chatContent(wrapped)?.extendedTextMessage?.text, 'menu');
});

test('an upsert made after the last flush waits in the buffer until flushed again', async () => {
  // Messages delivered after a reconnect are upserted outside Baileys' per-node flush,
  // which is why the worker flushes on a timer and before closing or stopping.
  const { ev, upserts } = capture();
  ev.buffer();
  ev.flush();
  const upsert = ev.createBufferedFunction(async (m: WAMessage) => {
    ev.emit('messages.upsert', { messages: [m], type: 'append' });
  });
  await upsert(message('late-offline', false));
  assert.equal(upserts.length, 0);
  assert.equal(ev.isBuffering(), true);
  ev.flush();
  assert.deepEqual(
    upserts.flatMap((u) => upsertedMessages(u)).map((m) => m.key.id),
    ['late-offline'],
  );
});
