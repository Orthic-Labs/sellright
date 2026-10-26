import { register } from '~/providers/shop/account/account';

export const SIGNUP_CONFLICT_ERROR =
	'We could not create an account with that email. Sign in, or reset your password if you already have an account.';

export const MIN_PASSWORD_LENGTH = 8; // matches the API (register / reset-password / change-password)

export type SignupResult = {
	step?: 'signin' | 'success';
	error?: string;
};

export async function registerCustomerFromSignup(input: {
	email: string;
	password: string;
	confirmPassword: string;
	firstName: string;
	lastName: string;
	errorMessage?: string;
	turnstileToken?: string;
}): Promise<SignupResult> {
	const firstName = input.firstName.trim();
	const lastName = input.lastName.trim();

	if (!firstName) return { error: 'First name is required.' };
	if (!lastName) return { error: 'Last name is required.' };
	if (!input.password || input.password.length < MIN_PASSWORD_LENGTH) {
		return { error: 'Password must be at least 8 characters.' };
	}
	if (input.password !== input.confirmPassword) {
		return { error: 'Passwords do not match.' };
	}

	try {
		const result = await register({
			email: input.email.trim(),
			password: input.password,
			firstName,
			lastName,
			turnstileToken: input.turnstileToken,
		});

		if (result.ok) return { step: 'success' };

		if (result.code === 'email_taken') {
			// Neutral, as the previous platform (O/routes/sign-in/index.tsx:18): do not confirm the address is registered.
			return { error: SIGNUP_CONFLICT_ERROR };
		}

		return { error: result.message || 'Registration failed. Please try again.' };
	} catch {
		return { error: input.errorMessage || 'An unexpected error occurred. Please try again.' };
	}
}
