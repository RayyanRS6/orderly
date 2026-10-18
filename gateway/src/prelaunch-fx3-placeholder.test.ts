import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import { Store } from './store.js';
import {
  expiredPlaceholders,
  inboundTarget,
  isSeen,
  PLACEHOLDER_WAIT_MS,
  queueMessage,
  releasePlaceholder,
  unreadId,
  withoutContent,
} from './inbound.js';
import { chatContent, messageText, upsertedMessages } from './upserts.js';
import { gatewayEventSchema, type GatewayEvent } from '../../src/shared/whatsapp.js';
// gateway-3: placeholder recovery (F28) must not hand normal chats to staff.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'orderly-fx3-inbound-'));
  const store = new Store(join(dir, 'session.sqlite'), Buffer.alloc(32, 8));
  return {
    store,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const LID = '100000001@lid';
const PN = '923001234567@s.whatsapp.net';
const connection = { connectionId: randomUUID(), generation: 1 };
const seconds = (ms = Date.now()) => Math.floor(ms / 1000);
function customer(remoteJid: string, id: string, extra: Partial<WAMessage> = {}): WAMessage {
  return {
    key: { remoteJid, id, fromMe: false },
    message: { conversation: 'menu' },
    messageTimestamp: seconds(),
    ...extra,
  };
}
const stub = (id: string) =>
  customer(LID, id, {
    message: undefined,
    messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
    messageStubParameters: ['Bad MAC'],
  });
// What the worker's incoming() does with an accepted message, without a socket.
function incoming(store: Store, message: WAMessage): GatewayEvent | undefined {
  const target = inboundTarget(store, message);
  if (!target) return;
  const timestamp = Number(message.messageTimestamp) * 1000;
  const content = chatContent(message.message);
  if (!content) {
    withoutContent(store, message, target, timestamp, Date.now());
    return;
  }
  if (isSeen(store, target.native, target.id, target.fromMe)) {
    if (target.held) store.delete('placeholder', target.id);
    return;
  }
  return queueMessage(store, {
    ...connection,
    native: target.native,
    id: target.id,
    timestamp,
    text: messageText(content),
    fromMe: target.fromMe,
  });
}
const { Type } = proto.Message.ProtocolMessage;

test('a held message that turns out to be a reaction, edit or deletion is never handed to staff', () => {
  const copies: proto.IMessage[] = [
    { reactionMessage: { text: '👍', key: { id: 'summary' } } },
    { ephemeralMessage: { message: { reactionMessage: { text: '👍' } } } },
    {
      editedMessage: {
        message: {
          protocolMessage: { type: Type.MESSAGE_EDIT, editedMessage: { conversation: '3' } },
        },
      },
    },
    { protocolMessage: { type: Type.REVOKE } },
  ];
  for (const [index, copy] of copies.entries()) {
    const f = fixture();
    try {
      const id = `held-${index}`;
      assert.equal(incoming(f.store, stub(id)), undefined);
      assert.equal(f.store.count('placeholder'), 1);
      // The sender's retry decrypts: it was a reaction (or an edit, or a deletion).
      assert.equal(incoming(f.store, customer(LID, id, { message: copy })), undefined);
      assert.equal(f.store.count('placeholder'), 0, JSON.stringify(copy));
      // Nothing for staff later, and a repeated stub is not held again.
      assert.deepEqual(expiredPlaceholders(f.store, Date.now() + PLACEHOLDER_WAIT_MS), []);
      assert.equal(incoming(f.store, stub(id)), undefined);
      assert.equal(f.store.count('placeholder'), 0);
      assert.equal(f.store.count('events'), 0);
    } finally {
      f.close();
    }
  }
});

test('a message whose content comes after staff were told still reaches Orderly under its own ID', () => {
  const f = fixture();
  try {
    assert.equal(incoming(f.store, stub('slow')), undefined);
    const now = Date.now() + PLACEHOLDER_WAIT_MS;
    const [due] = expiredPlaceholders(f.store, now);
    assert.equal(due?.id, 'slow');
    const notice = releasePlaceholder(
      f.store,
      { ...connection, id: due!.id, placeholder: due!.value },
      now,
    );
    // Staff are told under a derived ID that Orderly words as unreadable, not as media.
    assert.equal(notice.messageId, 'slow:unread');
    assert.equal(notice.unsupported, true);
    assert.equal(notice.peer, LID);
    assert.ok(gatewayEventSchema.safeParse(notice).success);
    // Told once; the real ID is not used up.
    assert.deepEqual(expiredPlaceholders(f.store, now + PLACEHOLDER_WAIT_MS), []);
    assert.equal(isSeen(f.store, LID, 'slow', false), false);
    // The phone's resend arrives late, in the phone-number form: filed in the same chat.
    const held = (id: string) => !!f.store.get('placeholder', id);
    const [copy] = upsertedMessages(
      { messages: [customer(PN, 'slow')], requestId: 'pdo-late' },
      held,
    );
    assert.ok(copy);
    const event = incoming(f.store, copy)!;
    assert.equal(event.messageId, 'slow');
    assert.equal(event.text, 'menu');
    assert.equal(event.peer, LID);
    assert.equal(event.fromMe, false);
    assert.equal(f.store.count('placeholder'), 0);
    assert.equal(incoming(f.store, customer(LID, 'slow')), undefined);
    assert.equal(f.store.count('events'), 2);
  } finally {
    f.close();
  }
});

test('placeholders a day old are dropped and long IDs keep the unreadable mark', () => {
  const f = fixture();
  try {
    const now = Date.now();
    assert.equal(incoming(f.store, stub('old')), undefined);
    f.store.set('placeholder', 'old', {
      native: LID,
      timestamp: now - 86400000 - 1000,
      at: now - 86400000,
      released: now - 86400000 + PLACEHOLDER_WAIT_MS,
    });
    assert.deepEqual(expiredPlaceholders(f.store, now), []);
    assert.equal(f.store.count('placeholder'), 0);
    const long = 'X'.repeat(220);
    assert.ok(unreadId(long).endsWith(':unread'));
    assert.ok(unreadId(long).length <= 150);
    assert.equal(unreadId(long), unreadId(long));
    const notice = releasePlaceholder(
      f.store,
      { ...connection, id: long, placeholder: { native: LID, timestamp: now, at: now } },
      now,
    );
    assert.ok(notice.messageId!.endsWith(':unread'));
    assert.ok(gatewayEventSchema.safeParse(notice).success);
  } finally {
    f.close();
  }
});
