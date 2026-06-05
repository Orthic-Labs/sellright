import { SubmitContactFormDocument, type SubmitContactFormMutation, type SubmitContactFormMutationVariables } from '~/generated/graphql-shop-typed';
import { requester } from '~/utils/api';

export interface ContactFormData {
  name: string;
  email: string;
  subject: string;
  message: string;
  turnstileToken?: string;
  honeypot?: string;
}

export async function submitContactForm(data: ContactFormData): Promise<{ success: boolean; message?: string }> {
  try {
    const result = await requester<SubmitContactFormMutation, SubmitContactFormMutationVariables>(
      SubmitContactFormDocument,
      {
        input: {
          name: data.name,
          email: data.email,
          subject: data.subject,
          message: data.message,
          turnstileToken: data.turnstileToken || undefined,
          honeypot: data.honeypot || undefined,
        },
      },
    );
    const payload = (result as any)?.submitContactForm;
    if (!payload) return { success: false, message: 'Unexpected error' };
    return { success: !!payload.success, message: payload.message ?? undefined };
  } catch (error: any) {
    console.error('Contact form submission failed:', error);
    return { success: false, message: error.message || 'Failed to send message' };
  }
}
