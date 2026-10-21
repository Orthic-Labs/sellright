import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const page = read('src/routes/account/passkeys/index.tsx');
const confirm = read('src/routes/account/passkeys/confirm/index.tsx');
const nav = read('src/components/account/AccountNav.tsx');

describe('account passkeys route', () => {
	it('is linked from the account navigation', () => {
		expect(nav).toMatch(/title: 'Passkeys',\s*href: '\/account\/passkeys'/);
	});

	it('lists label, synced / this device, created and last used', () => {
		expect(page).toContain('p.label');
		expect(page).toContain('Synced across your devices');
		expect(page).toContain('This device only');
		expect(page).toContain('Added ');
		expect(page).toContain('Last used ');
	});

	it('offers all three grant paths before adding or removing, and never calls delete or register without one', () => {
		expect(page).toContain('requestGrantWithPassword(password.value)');
		expect(page).toContain('grantWithPasskey()');
		expect(page).toContain('requestMailboxGrant()');
		expect(page).toMatch(/deletePasskey\(targetId\.value, g\)/);
		expect(page).toMatch(/registerPasskey\(grant\.value, name\)/);
		expect(page).toContain('Check your email');
		// the existing-passkey grant is only offered when the account has a passkey
		expect(page).toMatch(/items\.value\.length > 0 && \(\s*<button[^>]*data-testid="passkey-grant-passkey"/);
	});

	it('surfaces failures (including NO_RECOVERY_PATH) through the provider message, never silently', () => {
		expect(page).toContain('error.value = res.message');
		expect(read('src/providers/shop/account/passkeys.ts')).toContain('Add a password or another sign-in method before removing your last passkey');
	});
});

describe('account passkeys confirm route', () => {
	it('reads ?token=, redeems only on a click, then continues registration or removal with the grant', () => {
		expect(confirm).toContain("get('token')");
		expect(confirm).toContain('onClick$={confirm}');
		expect(confirm).not.toMatch(/useVisibleTask\$\([^)]*confirmMailboxGrant/);
		expect(confirm).toContain('confirmMailboxGrant(token.value)');
		expect(confirm).toContain('registerPasskey(grant.value, name)');
		expect(confirm).toContain('deletePasskey(targetId.value, res.grant)');
	});
});
