import { srContact, srErrorBody } from '~/utils/sellright';

export interface ContactFormData {
  name: string;
  email: string;
  subject: string;
  message: string;
  turnstileToken?: string;
  honeypot?: string;
}

/** SellRight REST contact submit — same fake-success semantics the source
 *  plugin had (honeypot returns ok without persisting, handled upstream). */
export async function submitContactForm(data: ContactFormData): Promise<{ success: boolean; message?: string }> {
  try {
    const result = await srContact({
      name: data.name,
      email: data.email,
      subject: data.subject,
      message: data.message,
      turnstileToken: data.turnstileToken || undefined,
      honeypot: data.honeypot || undefined,
    });
    return { success: !!result.ok, message: result.message };
  } catch (error: any) {
    const body = srErrorBody<{ error?: string }>(error);
    console.error('Contact form submission failed:', error);
    return { success: false, message: body?.error || error.message || 'Failed to send message' };
  }
}
