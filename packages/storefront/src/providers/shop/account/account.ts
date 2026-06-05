import {
	RegisterCustomerAccountMutationVariables,
	Success,
	UpdateCustomerInput,
} from '~/generated/graphql-shop';
import {
	LoginDocument,
	type LoginMutation,
	type LoginMutationVariables,
	LogoutDocument,
	type LogoutMutation,
	type LogoutMutationVariables,
	RegisterCustomerAccountDocument,
	type RegisterCustomerAccountMutation,
	VerifyCustomerAccountDocument,
	type VerifyCustomerAccountMutation,
	type VerifyCustomerAccountMutationVariables,
	UpdateCustomerDocument,
	type UpdateCustomerMutation,
	type UpdateCustomerMutationVariables,
	RequestUpdateCustomerEmailAddressDocument,
	type RequestUpdateCustomerEmailAddressMutation,
	type RequestUpdateCustomerEmailAddressMutationVariables,
	UpdateCustomerEmailAddressDocument,
	type UpdateCustomerEmailAddressMutation,
	type UpdateCustomerEmailAddressMutationVariables,
	ResetPasswordDocument,
	type ResetPasswordMutation,
	type ResetPasswordMutationVariables,
	RequestPasswordResetDocument,
	type RequestPasswordResetMutation,
	type RequestPasswordResetMutationVariables,
} from '~/generated/graphql-shop-typed';
import { requester } from '~/utils/api';

export const loginMutation = async (
	email: string,
	password: string,
	rememberMe: boolean
): Promise<LoginMutation> => {
	return requester<LoginMutation, LoginMutationVariables>(LoginDocument, { email, password, rememberMe });
};

export const logoutMutation = async (): Promise<Success> => {
	const res = await requester<LogoutMutation, LogoutMutationVariables>(LogoutDocument, undefined);
	return res.logout as Success;
};

export const registerCustomerAccountMutation = async (
	variables: RegisterCustomerAccountMutationVariables
): Promise<RegisterCustomerAccountMutation> => {
	return requester<RegisterCustomerAccountMutation, RegisterCustomerAccountMutationVariables>(
		RegisterCustomerAccountDocument,
		variables
	);
};

export const verifyCustomerAccountMutation = async (
	token: string,
	password?: string
): Promise<VerifyCustomerAccountMutation> => {
	return requester<VerifyCustomerAccountMutation, VerifyCustomerAccountMutationVariables>(
		VerifyCustomerAccountDocument,
		{ token, password }
	);
};

export const updateCustomerMutation = async (input: UpdateCustomerInput) => {
	return requester<UpdateCustomerMutation, UpdateCustomerMutationVariables>(UpdateCustomerDocument, { input });
};

export const requestUpdateCustomerEmailAddressMutation = async (
	password: string,
	newEmailAddress: string
) => {
	return requester<RequestUpdateCustomerEmailAddressMutation, RequestUpdateCustomerEmailAddressMutationVariables>(
		RequestUpdateCustomerEmailAddressDocument,
		{ password, newEmailAddress }
	);
};

export const updateCustomerEmailAddressMutation = async (token: string) => {
	const res = await requester<UpdateCustomerEmailAddressMutation, UpdateCustomerEmailAddressMutationVariables>(
		UpdateCustomerEmailAddressDocument,
		{ token }
	);
	return res.updateCustomerEmailAddress;
};

export const resetPasswordMutation = async (token: string, password: string) => {
	const res = await requester<ResetPasswordMutation, ResetPasswordMutationVariables>(
		ResetPasswordDocument,
		{ token, password }
	);
	return res.resetPassword;
};

export const requestPasswordResetMutation = async (emailAddress: string) => {
	const res = await requester<RequestPasswordResetMutation, RequestPasswordResetMutationVariables>(
		RequestPasswordResetDocument,
		{ emailAddress }
	);
	return res.requestPasswordReset;
};
