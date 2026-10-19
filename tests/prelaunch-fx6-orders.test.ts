// Final review, fx-6 (conversation-5, F35): an order staff never closed (not updated for 12 hours,
// or 24 while still waiting for acceptance) no longer blocks a returning customer's new cart.
// The order keeps the status staff gave it.
import { describe, expect, it } from 'vitest';
import { orderLeftOpen } from '../src/domain/engine';
import { at, biryani, company, latest, now, placed, turn } from './helpers/fx6-turns';

describe('F35: an order staff never closed does not block a new one', () => {
  it.each([
    ['accepted', 13],
    ['ready', 13],
    ['out_for_delivery', 30],
    ['pending', 25],
  ] as const)('a %s order not updated for %i hours lets a new cart start', (status, idle) => {
    const { conversation, order } = placed();
    const latestOrder = latest(order, status, at(-idle));
    const result = turn(company, conversation, '2 chicken biryani', { latestOrder });
    expect(result.conversation.cart).toMatchObject({
      status: 'building',
      items: [{ productId: biryani.id, quantity: 2 }],
    });
    expect(result.conversation.cart.orderId).toBeUndefined();
    expect(result.conversation.cart.revision).toBeGreaterThan(conversation.cart.revision);
    expect(result.traces).not.toContain('duplicate_submission_prevented');
    // The order keeps the status staff gave it.
    expect(latestOrder.status).toBe(status);
    expect(result.order).toBeUndefined();
  });

  it.each([
    ['accepted', 1],
    ['ready', 11],
    ['pending', 13],
  ] as const)('a %s order updated %i hours ago still holds the cart', (status, idle) => {
    const { conversation, order } = placed();
    const result = turn(company, conversation, '2 chicken biryani', {
      latestOrder: latest(order, status, at(-idle)),
    });
    expect(result.conversation.cart.status).toBe('submitted');
    expect(result.traces).toContain('duplicate_submission_prevented');
  });

  it('still answers “where is my order?” and passes a cancel to staff for that order', () => {
    const { conversation, order } = placed();
    const latestOrder = latest(order, 'ready', at(-14));
    const status = turn(company, conversation, 'where is my order?', { latestOrder });
    expect(status.traces).toContain('order_status');
    expect(status.conversation.cart.orderId).toBe(order.id);
    const cancel = turn(company, conversation, 'cancel my order', { latestOrder });
    expect(cancel.conversation.cart.status).toBe('submitted');
    expect(cancel.conversation.mode).toBe('human');
    // A finished order is the server's to release (as before), never this rule's.
    expect(orderLeftOpen({ status: 'completed', updatedAt: at(-48) }, now)).toBe(false);
  });
});
