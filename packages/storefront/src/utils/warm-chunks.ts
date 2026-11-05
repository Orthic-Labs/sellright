/**
 * #360: the login modal, the mobile menu and the verification modal are mounted only once opened. Their openers call these on
 * intent (pointerdown / hover / focus) so the chunk is already loading when the click lands. Safe to call repeatedly (the module
 * cache dedupes) and on the server (no-op); a failed load is ignored, the real open retries it.
 */
const warm = (load: () => Promise<unknown>): void => {
	if (typeof window === 'undefined') return;
	load().catch(() => undefined);
};

export const warmLoginModal = (): void => warm(() => import('~/components/auth/LoginModal'));
export const warmMenu = (): void => warm(() => import('~/components/menu/Menu'));
export const warmVerificationModal = (): void => warm(() => import('~/components/verification/VerificationModal'));
