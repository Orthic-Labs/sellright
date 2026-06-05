import { requester } from '~/utils/api';

const CheckCustomerEmailDoc = {
    toString() {
        return `query checkCustomerEmail($email: String!, $turnstileToken: String, $honeypot: String) {
  checkCustomerEmail(email: $email, turnstileToken: $turnstileToken, honeypot: $honeypot) {
    exists
  }
}`;
    },
} as any;

interface CheckEmailResult {
    checkCustomerEmail: { exists: boolean };
}

interface CheckEmailVars {
    email: string;
    turnstileToken?: string;
    honeypot?: string;
}

export async function checkCustomerEmail(
    email: string,
    turnstileToken?: string,
    honeypot?: string,
): Promise<boolean> {
    try {
        const result = await requester<CheckEmailResult, CheckEmailVars>(
            CheckCustomerEmailDoc,
            { email, turnstileToken, honeypot },
        );
        return result.checkCustomerEmail?.exists ?? false;
    } catch {
        return false;
    }
}
