import { describe, expect, it } from 'vitest';
import { firstCycleOutcome } from './subscription-first-cycle.js';

const base = { due: 4350, grandTotal: 4350, payable: true, paidLifecycle: false };

describe('firstCycleOutcome', () => {
  it('4350 order / 4000 paid: short, not Paid, mismatch flagged, 350 remaining', () => {
    expect(firstCycleOutcome({ ...base, amountPaid: 4000 })).toEqual({ remaining: 350, transitions: false, balance: false, mismatch: true });
  });
  it('4350 / 4350: covered, transitions to Paid, no mismatch', () => {
    expect(firstCycleOutcome({ ...base, amountPaid: 4350 })).toEqual({ remaining: 0, transitions: true, balance: false, mismatch: false });
  });
  it('4350 / 0 trial invoice: never Paid', () => {
    expect(firstCycleOutcome({ ...base, amountPaid: 0 })).toEqual({ remaining: 4350, transitions: false, balance: false, mismatch: true });
  });
  it('overpaid 4500 on 4350: Paid, mismatch flagged', () => {
    expect(firstCycleOutcome({ ...base, amountPaid: 4500 })).toMatchObject({ remaining: -150, transitions: true, mismatch: true });
  });
  it('earlier gift-card tender 1000: due 3350, paid 3350 covers it (mismatch vs total flagged)', () => {
    expect(firstCycleOutcome({ ...base, due: 3350, amountPaid: 3350 })).toMatchObject({ remaining: 0, transitions: true, mismatch: true });
  });
  it('already-paid order: payment inside the due amount is a balance payment, never a transition', () => {
    expect(firstCycleOutcome({ ...base, payable: false, paidLifecycle: true, due: 500, amountPaid: 500 })).toMatchObject({ transitions: false, balance: true, remaining: 0 });
  });
});
