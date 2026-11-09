import { describe, expect, it } from 'vitest';
import { applyLocationDelta } from './admin-catalog-location-stock.js';

describe('applyLocationDelta', () => {
  it('audit example 1: A and B start at 5/5 (on_hand 10); A=8 then B=2 applied sequentially keeps 10', () => {
    const a = applyLocationDelta({ previousLocation: 5, newLocation: 8, onHand: 10, allocated: 0 });
    expect(a.onHand).toBe(13);
    const b = applyLocationDelta({ previousLocation: 5, newLocation: 2, onHand: a.onHand, allocated: 0 });
    expect(b.onHand).toBe(10);
    expect(b.appliedDelta).toBe(-3);
  });
  it('audit example 3: no location row, on_hand 10, set L1=3 -> delta +3 from 0 -> 13', () => {
    const r = applyLocationDelta({ previousLocation: 0, newLocation: 3, onHand: 10, allocated: 0 });
    expect(r).toEqual({ onHand: 13, appliedDelta: 3, clamped: false });
  });
  it('drifted aggregate (sales took on_hand to 7, location row still 18): set to 20 adds 2', () => {
    expect(applyLocationDelta({ previousLocation: 18, newLocation: 20, onHand: 7, allocated: 0 }).onHand).toBe(9);
  });
  it('never below 0', () => {
    const r = applyLocationDelta({ previousLocation: 39, newLocation: 0, onHand: 0, allocated: 0 });
    expect(r).toEqual({ onHand: 0, appliedDelta: 0, clamped: true });
  });
  it('never below allocated', () => {
    const r = applyLocationDelta({ previousLocation: 10, newLocation: 0, onHand: 10, allocated: 4 });
    expect(r).toEqual({ onHand: 4, appliedDelta: -6, clamped: true });
  });
  it('unchanged location value is a no-op', () => {
    expect(applyLocationDelta({ previousLocation: 5, newLocation: 5, onHand: 9, allocated: 2 })).toEqual({ onHand: 9, appliedDelta: 0, clamped: false });
  });
});
