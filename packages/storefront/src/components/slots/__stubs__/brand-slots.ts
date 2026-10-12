// Test stand-in for `virtual:sellright-brand-slots` (vitest.render.config.ts): no brand slots unless a test registers one.
import type { SlotMap } from '../registry';

export const brandSlots: SlotMap = {};
