import { describe, expect, it } from 'vitest';
import { canTransition, type OrderState } from './fsm.js';

// Every (from, to) pair where transition IS allowed — derived from
// money/fsm.ts ORDER_TRANSITIONS. The test asserts the table shape AND its
// negation: if anyone refactors the table, both the positive and negative
// expectations here will fire, surfacing a regression before it ships.
const ALLOWED: Array<[OrderState, OrderState]> = [
  ['PendingPayment', 'Paid'],
  ['PendingPayment', 'Cancelled'],
  ['Paid', 'PartiallyRefunded'],
  ['Paid', 'Refunded'],
  ['Paid', 'Cancelled'],
  ['PartiallyRefunded', 'Refunded'],
];

// Same (from, to) pair but for a *different* terminal state — these MUST be
// rejected. Picking representative ones from each terminal so the
// already-closed buckets (Refunded, Cancelled) are covered too.
const REJECTED: Array<[OrderState, OrderState]> = [
  ['Refunded', 'PartiallyRefunded'],
  ['Refunded', 'Cancelled'],
  ['Refunded', 'Paid'],
  ['Cancelled', 'Paid'],
  ['Cancelled', 'Refunded'],
  ['PartiallyRefunded', 'Cancelled'],
  ['PartiallyRefunded', 'Paid'],
  ['PendingPayment', 'Refunded'], // skipping Paid — would allow refunding a never-paid order
  ['PendingPayment', 'PartiallyRefunded'],
  ['Paid', 'PendingPayment'], // no rolling back
];

describe('canTransition — money FSM', () => {
  for (const [from, to] of ALLOWED) {
    it(`allows ${from} → ${to}`, () => {
      expect(canTransition(from, to)).toBe(true);
    });
  }
  for (const [from, to] of REJECTED) {
    it(`rejects ${from} → ${to}`, () => {
      expect(canTransition(from, to)).toBe(false);
    });
  }

  it('terminal states are absorbing (Refunded → anything stays false)', () => {
    const targets: OrderState[] = ['PendingPayment', 'Paid', 'PartiallyRefunded', 'Refunded', 'Cancelled'];
    for (const t of targets) expect(canTransition('Refunded', t)).toBe(false);
  });
  it('terminal states are absorbing (Cancelled → anything stays false)', () => {
    const targets: OrderState[] = ['PendingPayment', 'Paid', 'PartiallyRefunded', 'Refunded', 'Cancelled'];
    for (const t of targets) expect(canTransition('Cancelled', t)).toBe(false);
  });
});
