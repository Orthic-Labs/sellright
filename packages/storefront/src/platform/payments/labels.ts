// A20: the one place base code names a payment provider for display or routing. Everything else imports from here, so
// brand-lint's `vendor-ui` rule (layers.json brandLint.vendorUiAllowFiles lists this file) can stay blocking elsewhere.
// Static data only: no fetch, no stock or payment logic. The provider id strings are the wire ids the API reports under
// `config.gateways`, unchanged.
export type PaymentProviderId = 'stripe' | 'nmi' | 'sezzle';

/** The hosted installment gateway's id (what `config.gateways.<id>` and the gateway-payment routes use). */
export const INSTALLMENT_PROVIDER = 'sezzle' as const satisfies PaymentProviderId;

export const PROVIDER_LABELS: Readonly<Record<PaymentProviderId, string>> = {
	stripe: 'Stripe',
	nmi: 'NMI',
	sezzle: 'Sezzle',
};

export const providerLabel = (id: PaymentProviderId): string => PROVIDER_LABELS[id];

/** `Continue to <Provider>` (the balance-pay installment button text, which used to say the provider name inline). */
export const continueToLabel = (id: PaymentProviderId): string => `Continue to ${providerLabel(id)}`;

/** Origins the document head pre-resolves for the installment gateway (live and sandbox), in the order the head emitted them. */
export const PROVIDER_PREFETCH_ORIGINS = ['https://gateway.sezzle.com', 'https://sandbox.gateway.sezzle.com'] as const;
