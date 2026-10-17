import type { LoyaltySettings } from '../money/loyalty.js';
import type { ImportContext } from './context.js';

/** Source monetary credit has its own balance/ledger. Never duplicate it as points. */
export async function importLoyalty(_ctx: ImportContext, _settings: LoyaltySettings | null): Promise<{ imported: number; points: number }> {
  return { imported: 0, points: 0 };
}
