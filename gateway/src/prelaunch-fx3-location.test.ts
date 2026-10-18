import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { proto } from '@whiskeysockets/baileys';
import { chatContent, messageText } from './upserts.js';
// gateway-8: a live location is read like a location pin, not handed to staff.
test('a live location becomes customer text like a location pin', () => {
  const text = (message: proto.IMessage) => messageText(chatContent(message)!);
  assert.equal(
    text({
      liveLocationMessage: {
        degreesLatitude: 31.5204,
        degreesLongitude: 74.3587,
        caption: 'Coming from Liberty',
      },
    }),
    'Location shared: Coming from Liberty (31.5204, 74.3587)',
  );
  assert.equal(
    text({ liveLocationMessage: { degreesLatitude: 31.5, degreesLongitude: 74.3 } }),
    'Location shared: (31.5, 74.3)',
  );
  assert.equal(text({ liveLocationMessage: {} }), '');
});
