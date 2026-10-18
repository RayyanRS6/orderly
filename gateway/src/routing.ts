import { canonicalJid } from './policy.js';
import type { Store } from './store.js';

// Links a customer's privacy ID (LID) with their phone-number JID, so messages under either form
// reach one Orderly chat. Only missing routes are filled: an existing route names the chat Orderly
// already keeps (its cart, a staff takeover), so a late mapping never moves it. 'conflict' means
// both forms already lead to different chats; they stay apart.
export function mapIdentity(
  store: Store,
  lidValue?: string | null,
  pnValue?: string | null,
  self: (string | undefined)[] = [],
): 'mapped' | 'conflict' | undefined {
  const lid = canonicalJid(lidValue);
  const pn = canonicalJid(pnValue);
  if (!lid?.endsWith('@lid') || !pn?.endsWith('@s.whatsapp.net')) return;
  // The business's own identities never become a customer's.
  if (self.includes(lid) || self.includes(pn)) return;
  return store.transaction(() => {
    const lidRoute = store.get<string>('route', lid);
    const pnRoute = store.get<string>('route', pn);
    store.set('identity', lid, pn);
    const route = lidRoute ?? pnRoute ?? lid;
    if (!lidRoute) store.set('route', lid, route);
    if (!pnRoute) store.set('route', pn, route);
    return lidRoute && pnRoute && lidRoute !== pnRoute ? 'conflict' : 'mapped';
  });
}
// WhatsApp names the other form of a customer's identity on each of their messages: the phone
// JID on a LID chat (senderPn) and the LID on a phone chat (senderLid). On staff messages typed
// on the phone these name the business itself, so they are ignored.
export function messageIdentity(
  native: string,
  key: { fromMe?: boolean | null; senderPn?: string | null; senderLid?: string | null },
): { lid?: string | null; pn?: string | null } | undefined {
  if (key.fromMe) return;
  return native.endsWith('@lid')
    ? { lid: native, pn: key.senderPn }
    : { lid: key.senderLid, pn: native };
}
// The chat a message belongs to in Orderly, and the phone number when it is known.
export function resolveRoute(store: Store, native: string) {
  return {
    peer: store.get<string>('route', native) ?? native,
    phoneJid: store.get<string>('identity', native) ?? native,
  };
}
