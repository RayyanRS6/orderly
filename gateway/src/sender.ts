import { createHash } from 'node:crypto';
import type { Store } from './store.js';

export type Receipt = {
  fingerprint: string;
  messageId: string;
  state: 'sending' | 'accepted' | 'uncertain';
  at: number;
};
export function recoverUncertainSends(store: Store) {
  for (const row of store.list<Receipt>('receipts'))
    if (row.value.state === 'sending')
      store.set('receipts', row.id, { ...row.value, state: 'uncertain' });
}
export async function sendOnce(
  store: Store,
  body: { idempotencyKey: string; peer: string; text: string; generation: number },
  messageId: string,
  deliver: () => Promise<string>,
) {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([body.peer, body.text, body.generation]))
    .digest('hex');
  const previous = store.get<Receipt>('receipts', body.idempotencyKey);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
    if (previous.state !== 'accepted') throw new Error('SEND_UNCERTAIN');
    return { messageId: previous.messageId };
  }
  const receipt: Receipt = { fingerprint, messageId, state: 'sending', at: Date.now() };
  store.transaction(() => {
    store.set('receipts', body.idempotencyKey, receipt);
    store.set('own', messageId, Date.now());
  });
  try {
    const actualId = await deliver();
    if (!actualId) throw new Error('NO_RECEIPT');
    store.transaction(() => {
      store.set('receipts', body.idempotencyKey, {
        ...receipt,
        state: 'accepted',
        messageId: actualId,
      });
      store.set('own', actualId, Date.now());
    });
    return { messageId: actualId };
  } catch {
    store.set('receipts', body.idempotencyKey, { ...receipt, state: 'uncertain' });
    throw new Error('SEND_UNCERTAIN');
  }
}
