import { registerCustomerAccountMutation } from '~/providers/shop/account/account';

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
}): Promise<SignupResult> {
 const firstName = input.firstName.trim();
 const lastName = input.lastName.trim();

 if (!firstName) return { error: 'First name is required.' };
 if (!lastName) return { error: 'Last name is required.' };
 if (!input.password || input.password.length < 6) {
  return { error: 'Password must be at least 6 characters.' };
 }
 if (input.password !== input.confirmPassword) {
  return { error: 'Passwords do not match.' };
 }

 try {
  const result = await registerCustomerAccountMutation({
   input: {
    emailAddress: input.email.trim(),
    password: input.password,
    firstName,
    lastName,
   },
  });
  const registration = result?.registerCustomerAccount;
  if (registration?.__typename === 'Success' && registration.success === true) {
   return { step: 'success' };
  }

  if ((registration as any)?.errorCode === 'EMAIL_ADDRESS_CONFLICT_ERROR') {
   return {
    step: 'signin',
    error: 'An account with this email already exists. Please sign in.',
   };
  }

  return { error: (registration as any)?.message || 'Registration failed. Please try again.' };
 } catch {
  return { error: input.errorMessage || 'An unexpected error occurred. Please try again.' };
 }
}
