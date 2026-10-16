// Fixture base L2 file that still calls orchestration directly (base-reviewed, reported until A13).
import { refreshCartStock } from '~/platform/checkout';

export const open = () => refreshCartStock();
