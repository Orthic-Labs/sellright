import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(join(process.cwd(), 'src/routes/sign-in/index.tsx'), 'utf8');

describe('sign-in page: passkey button gating', () => {
	it('reads auth.passkeys from the shop config and also requires a WebAuthn-capable browser', () => {
		expect(page).toContain('auth?.passkeys === true && browserSupportsWebAuthn()');
		expect(page).toContain('passkeysEnabled.value = false'); // fail closed when the config cannot be read
	});

	it('renders the passkey button only when supported, and a success follows the password-login path', () => {
		expect(page).toMatch(/passkeySupported\.value && \(\s*<button[^>]*data-testid="passkey-signin-button"/);
		expect(page).toMatch(/loginWithPasskey\(\);\s*if \(result\.ok\) \{\s*navigate\('\/account'\)/);
	});

	it('starts conditional UI only on the sign-in view with autofill support, and tags the email field', () => {
		expect(page).toContain("if (!track(() => passkeysEnabled.value) || current !== 'signin') return;");
		expect(page).toContain('browserSupportsWebAuthnAutofill()');
		expect(page).toContain('loginWithPasskey({ useBrowserAutofill: true })');
		expect(page).toContain('"username webauthn"');
		expect(page).toContain("if (!('cancelled' in result)) error.value = result.message;"); // a dismissed prompt stays silent
	});
});

describe('sign-in page: Apple button gating', () => {
	it('resolves the client id per validated request host and renders the button only when it is non-empty', () => {
		expect(page).toMatch(/useAppleClientId = routeLoader\$[\s\S]*?appleSignInClientIdForHost\(\s*validatedRequestHost\(/);
		expect(page).toMatch(/appleClientId\.value && \(\s*<>\s*<button[^>]*id="apple-signin-button"/);
	});

	it('signs in through the SDK then the API, and a cancelled popup shows nothing', () => {
		expect(page).toContain('signInWithApple(appleClientId.value)');
		expect(page).toContain("if (outcome.status === 'cancelled')");
		expect(page).toMatch(/loginWithApple\(outcome\.identityToken\);\s*if \(result\.ok\) \{\s*navigate\('\/account'\)/);
	});

	it('leaves the Google block untouched', () => {
		expect(page).toMatch(/googleClientId\.value && \(\s*<>[\s\S]*?id="google-signin-button"/);
	});
});
