// A17: the slot lookup. Only the presentation gateway calls it (platform/gateway/gate.tsx `slotGate`/`hasView`; enforced by
// scripts/check-gateway.mjs): mount points render the slot's gateway handle, which validates the props and renders the brand
// component when it exists, the fallback otherwise.
import { brandSlots } from 'virtual:sellright-brand-slots';
import { pickSlot, type SlotComponent, type SlotName } from './registry';

export type { SlotComponent, SlotName, SlotProps } from './registry';

export const getSlot = <K extends SlotName>(name: K): SlotComponent<K> | undefined => pickSlot(brandSlots, name);
