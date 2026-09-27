import { srShopConfig, type SrLoyaltyProgram } from '~/utils/sellright';

// One shop-config read per page load for the points widgets. Object-property
// holder (not a module-level `let`) so the minifier can't fold it into a const.
const holder: { program?: Promise<SrLoyaltyProgram | null> } = {};

/** The store's public points-program terms, or null when the program is off
 *  (or the config can't be read — the widgets then render nothing). */
export const loadLoyaltyProgram = (): Promise<SrLoyaltyProgram | null> =>
	(holder.program ??= srShopConfig()
		.then((cfg) => (cfg.loyalty?.enabled ? cfg.loyalty : null))
		.catch(() => {
			holder.program = undefined;
			return null;
		}));

export const formatPoints = (n: number) => n.toLocaleString('en-US');
