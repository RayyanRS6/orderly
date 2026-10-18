import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import { Store } from './store.js';
import { mapIdentity, messageIdentity, resolveRoute } from './routing.js';
import {
  awaitsContent,
  expiredPlaceholders,
  holdPlaceholder,
  inboundTarget,
  isSeen,
  PLACEHOLDER_WAIT_MS,
  queueMessage,
} from './inbound.js';
import { chatContent, messageText, upsertedMessages } from './upserts.js';
import { phoneFromJid } from './policy.js';
import { gatewayEventSchema, type GatewayEvent } from '../../src/shared/whatsapp.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'orderly-inbound-test-'));
  const store = new Store(join(dir, 'session.sqlite'), Buffer.alloc(32, 6));
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
const BUSINESS = '923000000001@s.whatsapp.net';
const connection = { connectionId: randomUUID(), generation: 1 };
const now = () => Math.floor(Date.now() / 1000);
function customer(remoteJid: string, id: string, extra: Partial<WAMessage> = {}): WAMessage {
  return {
    key: { remoteJid, id, fromMe: false },
    message: { conversation: 'menu' },
    messageTimestamp: now(),
    ...extra,
  };
}
// What the worker does with an accepted message, without a socket.
function file(store: Store, message: WAMessage): GatewayEvent | undefined {
  const target = inboundTarget(store, message)!;
  const content = chatContent(message.message);
  if (!content) {
    if (awaitsContent(message) && !isSeen(store, target.native, target.id, target.fromMe))
      holdPlaceholder(
        store,
        target.id,
        target.native,
        Number(message.messageTimestamp) * 1000,
        Date.now(),
      );
    return;
  }
  if (isSeen(store, target.native, target.id, target.fromMe)) return;
  const identity = messageIdentity(target.native, message.key);
  if (identity) mapIdentity(store, identity.lid, identity.pn, [BUSINESS]);
  return queueMessage(store, {
    ...connection,
    native: target.native,
    id: target.id,
    timestamp: Number(message.messageTimestamp) * 1000,
    text: messageText(content),
    fromMe: target.fromMe,
  });
}

// F30: WhatsApp moving a customer from phone-number to LID addressing mid-order must not open
// a second, empty conversation.
test('a phone-number chat followed by a LID message that names the phone stays one chat', () => {
  const f = fixture();
  try {
    const first = file(f.store, customer(PN, 'one'))!;
    assert.equal(first.peer, PN);
    const second = file(
      f.store,
      customer(LID, 'two', { key: { remoteJid: LID, id: 'two', fromMe: false, senderPn: PN } }),
    )!;
    assert.equal(second.peer, PN);
    assert.equal(second.phoneNumber, '+923001234567');
  } finally {
    f.close();
  }
});

test('a LID chat followed by a phone-number message that names the LID stays one chat', () => {
  const f = fixture();
  try {
    const first = file(f.store, customer(LID, 'one'))!;
    assert.equal(first.peer, LID);
    assert.equal(first.phoneNumber, undefined);
    const second = file(
      f.store,
      customer(PN, 'two', { key: { remoteJid: PN, id: 'two', fromMe: false, senderLid: LID } }),
    )!;
    assert.equal(second.peer, LID);
    // The phone is now known for later LID messages as well.
    const third = file(f.store, customer(LID, 'three'))!;
    assert.equal(third.peer, LID);
    assert.equal(third.phoneNumber, '+923001234567');
  } finally {
    f.close();
  }
});

test('two chats that already exist are never merged or moved by a later mapping', () => {
  const f = fixture();
  try {
    file(f.store, customer(PN, 'one'));
    file(f.store, customer(LID, 'two'));
    assert.equal(mapIdentity(f.store, LID, PN), 'conflict');
    assert.equal(resolveRoute(f.store, PN).peer, PN);
    assert.equal(resolveRoute(f.store, LID).peer, LID);
    // A contact event in the other order does not move them either.
    assert.equal(mapIdentity(f.store, LID, PN), 'conflict');
    assert.equal(resolveRoute(f.store, PN).peer, PN);
    // The phone number is still recorded for the LID chat.
    assert.equal(phoneFromJid(resolveRoute(f.store, LID).phoneJid), '+923001234567');
  } finally {
    f.close();
  }
});

test("staff messages and the business's own number never create a customer mapping", () => {
  const f = fixture();
  try {
    const staff = { remoteJid: LID, id: 's', fromMe: true, senderPn: BUSINESS };
    assert.equal(messageIdentity(LID, staff), undefined);
    assert.equal(mapIdentity(f.store, LID, BUSINESS, [BUSINESS]), undefined);
    assert.equal(f.store.count('identity'), 0);
    assert.equal(f.store.count('route'), 0);
  } finally {
    f.close();
  }
});

// F28: a customer message this device only receives through the phone's placeholder resend.
test('a placeholder resend is delivered once, in the placeholder chat, and never twice', () => {
  const f = fixture();
  try {
    const stub = customer(LID, 'lost', {
      message: undefined,
      messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
      messageStubParameters: ['Message absent from node'],
    });
    assert.equal(awaitsContent(stub), true);
    assert.equal(file(f.store, stub), undefined);
    assert.equal(f.store.count('placeholder'), 1);
    assert.equal(f.store.count('events'), 0);
    // The phone answers with its own copy, in its own JID form.
    const held = (id: string) => !!f.store.get('placeholder', id);
    const resend = { messages: [customer(PN, 'lost')], requestId: 'pdo-1' };
    const [copy] = upsertedMessages(resend, held);
    assert.ok(copy);
    const event = file(f.store, copy)!;
    assert.equal(event.peer, LID);
    assert.equal(event.text, 'menu');
    assert.equal(event.fromMe, false);
    assert.equal(f.store.count('placeholder'), 0);
    // The same message again, under either JID form or as an unrequested resend: suppressed.
    assert.equal(file(f.store, customer(PN, 'lost')), undefined);
    assert.equal(file(f.store, customer(LID, 'lost')), undefined);
    assert.deepEqual(upsertedMessages({ ...resend, requestId: 'pdo-2' }, held), []);
    assert.equal(f.store.count('events'), 1);
  } finally {
    f.close();
  }
});

test('a placeholder whose content never arrives is handed to staff once', () => {
  const f = fixture();
  try {
    const at = Date.now();
    holdPlaceholder(f.store, 'never', LID, at, at);
    holdPlaceholder(f.store, 'never', LID, at, at);
    assert.equal(f.store.count('placeholder'), 1);
    assert.deepEqual(expiredPlaceholders(f.store, at + PLACEHOLDER_WAIT_MS - 1), []);
    const [due] = expiredPlaceholders(f.store, at + PLACEHOLDER_WAIT_MS);
    assert.equal(due?.id, 'never');
    const event = queueMessage(f.store, {
      ...connection,
      native: due!.value.native,
      id: due!.id,
      timestamp: due!.value.timestamp,
      text: '',
      fromMe: false,
    });
    // Unsupported with no text: Orderly turns this into a staff handoff.
    assert.equal(event.unsupported, true);
    assert.ok(gatewayEventSchema.safeParse(event).success);
    assert.equal(f.store.count('placeholder'), 0);
    assert.equal(isSeen(f.store, LID, 'never', false), true);
    // Our own messages and messages with content are never held.
    assert.equal(
      awaitsContent({
        ...customer(LID, 'own', {
          message: undefined,
          messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
        }),
        key: { remoteJid: LID, id: 'own', fromMe: true },
      }),
      false,
    );
    assert.equal(
      awaitsContent(
        customer(LID, 'text', { messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT }),
      ),
      false,
    );
  } finally {
    f.close();
  }
});

test('a queued message with an over-long ID is still accepted by Orderly', () => {
  const f = fixture();
  try {
    const event = file(f.store, customer(LID, 'X'.repeat(220)))!;
    assert.ok(gatewayEventSchema.safeParse(event).success);
    assert.equal(isSeen(f.store, LID, 'X'.repeat(220), false), true);
  } finally {
    f.close();
  }
});

// F01 (linked phone): captions and location pins are read, real media still goes to staff.
test('captions and location pins become customer text; voice notes and stickers stay media', () => {
  const text = (message: proto.IMessage) => messageText(chatContent(message)!);
  assert.equal(
    text({ imageMessage: { caption: '2 biryani please' } }),
    '2 biryani please (sent with a photo)',
  );
  assert.equal(text({ videoMessage: { caption: ' this one ' } }), 'this one (sent with a video)');
  assert.equal(
    text({ documentWithCaptionMessage: { message: { documentMessage: { caption: 'order' } } } }),
    'order (sent with a document)',
  );
  assert.equal(
    text({
      locationMessage: {
        degreesLatitude: 31.5204,
        degreesLongitude: 74.3587,
        name: 'Liberty Market',
        address: 'Gulberg III, Lahore',
      },
    }),
    'Location shared: Liberty Market, Gulberg III, Lahore (31.5204, 74.3587)',
  );
  assert.equal(
    text({ locationMessage: { degreesLatitude: 33.6844123456, degreesLongitude: 73.0479 } }),
    'Location shared: (33.684412, 73.0479)',
  );
  assert.equal(text({ buttonsResponseMessage: { selectedDisplayText: 'Confirm' } }), 'Confirm');
  assert.equal(text({ listResponseMessage: { title: 'Zinger burger' } }), 'Zinger burger');
  assert.equal(text({ extendedTextMessage: { text: 'menu' } }), 'menu');
  for (const media of [
    { audioMessage: { seconds: 4 } },
    { stickerMessage: {} },
    { imageMessage: {} },
    { imageMessage: { caption: '   ' } },
    { contactMessage: { displayName: 'Ali' } },
  ])
    assert.equal(text(media), '', JSON.stringify(media));
  assert.ok(text({ imageMessage: { caption: 'x'.repeat(5000) } }).length <= 4000);
  assert.ok(text({ imageMessage: { caption: 'x'.repeat(5000) } }).endsWith('(sent with a photo)'));
});
