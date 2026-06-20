/**
 * Account auth provider — migrated from Vendure GraphQL to the SellRight REST
 * shop API (PASS 2). Return shapes preserve the Vendure discriminated unions the
 * components switch on (`__typename === 'CurrentUser' | 'Success' |
 * 'InvalidCredentialsError' | …`) so sign-in / register / verify / reset pages
 * need no changes.
 */
import type {
	RegisterCustomerAccountMutationVariables,
	Success,
	UpdateCustomerInput,
} from '~/generated/graphql-shop';
import type { LoginMutation } from '~/generated/graphql-shop-typed';
import {
	srLogin,
	srLogout,
	srRegister,
	srVerifyEmail,
	srUpdateProfile,
	srResetPassword,
	srForgotPassword,
	srErrorStatus,
} from '~/utils/sellright';

export const loginMutation = async (
	email: string,
	password: string,
	_rememberMe: boolean
): Promise<LoginMutation> => {
	try {
		const res = await srLogin(email, password);
		return { login: { __typename: 'CurrentUser', id: res.customer.id, identifier: res.customer.email } } as unknown as LoginMutation;
	} catch (e) {
		const status = srErrorStatus(e);
		const message = status === 429 ? 'Too many attempts — please try again later' : 'Invalid email or password';
		return { login: { __typename: 'InvalidCredentialsError', errorCode: 'INVALID_CREDENTIALS_ERROR', message } } as unknown as LoginMutation;
	}
};

export const logoutMutation = async (): Promise<Success> => {
	try {
		await srLogout();
	} catch {
		// best-effort
	}
	return { success: true } as Success;
};

export const registerCustomerAccountMutation = async (
	variables: RegisterCustomerAccountMutationVariables
): Promise<any> => {
	const input = (variables as any)?.input ?? {};
	try {
		await srRegister({
			email: input.emailAddress,
			password: input.password,
			firstName: input.firstName ?? undefined,
			lastName: input.lastName ?? undefined,
		});
		return { registerCustomerAccount: { __typename: 'Success', success: true } };
	} catch (e) {
		const status = srErrorStatus(e);
		const message =
			status === 409 ? 'That email is already registered' :
			status === 429 ? 'Too many attempts — please try again later' :
			'Registration failed';
		return {
			registerCustomerAccount: {
				__typename: status === 409 ? 'EmailAddressConflictError' : 'MissingPasswordError',
				success: false,
				errorCode: status === 409 ? 'EMAIL_ADDRESS_CONFLICT_ERROR' : 'UNKNOWN_ERROR',
				message,
			},
		};
	}
};

export const verifyCustomerAccountMutation = async (
	token: string,
	_password?: string
): Promise<any> => {
	try {
		await srVerifyEmail(token);
		return { verifyCustomerAccount: { __typename: 'CurrentUser', id: '', identifier: '' } };
	} catch (e) {
		const status = srErrorStatus(e);
		const message = status === 429 ? 'Too many attempts — please try again later' : 'Verification link is invalid, expired, or already used';
		return { verifyCustomerAccount: { __typename: 'VerificationTokenInvalidError', errorCode: 'VERIFICATION_TOKEN_INVALID_ERROR', message } };
	}
};

export const updateCustomerMutation = async (input: UpdateCustomerInput) => {
	const i = input as any;
	const res = await srUpdateProfile({
		firstName: i.firstName ?? undefined,
		lastName: i.lastName ?? undefined,
		phone: i.phoneNumber ?? undefined,
	});
	return { updateCustomer: { __typename: 'Customer', ...res } } as any;
};

// Email-address change is not exposed by the SellRight shop API. These keep the
// call sites compiling and degrade to a clear, non-crashing error.
export const requestUpdateCustomerEmailAddressMutation = async (
	_password: string,
	_newEmailAddress: string
) => {
	return {
		requestUpdateCustomerEmailAddress: {
			__typename: 'NativeAuthStrategyError',
			errorCode: 'NATIVE_AUTH_STRATEGY_ERROR',
			message: 'Changing your email address is not currently supported.',
		},
	} as any;
};

export const updateCustomerEmailAddressMutation = async (_token: string) => {
	return {
		updateCustomerEmailAddress: {
			__typename: 'IdentifierChangeTokenInvalidError',
			errorCode: 'IDENTIFIER_CHANGE_TOKEN_INVALID_ERROR',
			message: 'Changing your email address is not currently supported.',
		},
	} as any;
};

export const resetPasswordMutation = async (token: string, password: string) => {
	try {
		await srResetPassword(token, password);
		return { __typename: 'CurrentUser', id: '', identifier: '' } as any;
	} catch (e) {
		const status = srErrorStatus(e);
		const message = status === 409 ? 'This reset link is invalid, expired, or already used' : 'Password reset failed';
		return { __typename: 'PasswordResetTokenInvalidError', errorCode: 'PASSWORD_RESET_TOKEN_INVALID_ERROR', message } as any;
	}
};

export const requestPasswordResetMutation = async (emailAddress: string) => {
	// The API is enumeration-safe (always 200). Mirror that: always Success.
	try {
		await srForgotPassword(emailAddress);
	} catch {
		// even on a transient error, do not leak account existence
	}
	return { __typename: 'Success', success: true } as any;
};
