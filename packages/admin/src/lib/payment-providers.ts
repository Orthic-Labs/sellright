export const ADMIN_PAYMENT_PROVIDERS = ['manual', 'cod', 'stripe'] as const;
export type AdminPaymentProvider = typeof ADMIN_PAYMENT_PROVIDERS[number];
