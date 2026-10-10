// A17: app-facing slot lookup. Mount points call `getSlot('<name>')` at module level and render the component when it
// exists, their own fallback markup otherwise.
import { brandSlots } from 'virtual:sellright-brand-slots';
import { pickSlot, type SlotComponent, type SlotName } from './registry';

export type { SlotComponent, SlotName, SlotProps } from './registry';

export const getSlot = <K extends SlotName>(name: K): SlotComponent<K> | undefined => pickSlot(brandSlots, name);
