import { getShopConfig } from '~/providers/shop/checkout/checkout';
import type { LoyaltyProgram } from '~/sellright/types/rewards';

// One shop-config read per page load for the points widgets. Object-property
// holder (not a module-level `let`) so the minifier can't fold it into a const.
// Program terms are store settings, not stock: sharing one in-flight request
// just stops the PDP / cart / checkout widgets each re-fetching the same config.
const holder: { program?: Promise<LoyaltyProgram | null> } = {};

/** The store's public points-program terms, or null when the program is off
 *  (or the config can't be read — the widgets then render nothing). A
 *  failure is not remembered, so the next caller retries. */
export const loadLoyaltyProgram = (): Promise<LoyaltyProgram | null> =>
	(holder.program ??= getShopConfig()
		.then((cfg) => (cfg.loyalty?.enabled ? cfg.loyalty : null))
		.catch(() => {
			holder.program = undefined;
			return null;
		}));

export const formatPoints = (n: number) => n.toLocaleString('en-US');
