/**
 * Express checkout (Apple Pay / Google Pay through Stripe's Express Checkout Element): every web domain that shows a
 * wallet button must be registered as a Stripe PaymentMethodDomain on the account that runs the charge. Apple Pay
 * requires it; Stripe performs Apple's merchant validation itself, so no Apple merchant id, CSR or hosted
 * `.well-known/apple-developer-merchantid-domain-association` file is involved
 * (https://docs.stripe.com/payments/payment-methods/pmd-registration). A domain registered in live mode is also
 * registered in sandboxes.
 *
 * `ensurePaymentMethodDomains` is idempotent per domain: an existing registration is reused (re-enabled when disabled,
 * re-validated when a wallet is not yet active); only a missing one is created. One domain failing never stops the
 * rest, and its error is reported per domain. The injected client keeps this SDK-free and unit-testable.
 */

export type WalletDomainStatus = 'active' | 'inactive' | 'unknown';

export interface PaymentMethodDomainLike {
  id: string;
  domain_name: string;
  enabled: boolean;
  apple_pay?: { status?: string } | null;
  google_pay?: { status?: string } | null;
}

export interface StripePaymentMethodDomainClient {
  paymentMethodDomains: {
    list(params: { domain_name: string; limit: number }): Promise<{ data: PaymentMethodDomainLike[] }>;
    create(params: { domain_name: string; enabled: boolean }): Promise<PaymentMethodDomainLike>;
    update(id: string, params: { enabled: boolean }): Promise<PaymentMethodDomainLike>;
    validate(id: string): Promise<PaymentMethodDomainLike>;
  };
}

export interface DomainRegistration {
  domain: string;
  id: string | null;
  /** created = newly registered; updated = re-enabled or re-validated; unchanged = already registered and active. */
  outcome: 'created' | 'updated' | 'unchanged' | 'failed';
  enabled: boolean;
  applePay: WalletDomainStatus;
  googlePay: WalletDomainStatus;
  error?: string;
}

/** At most this many domains per store per call (a store has a handful; the cap bounds provider calls). */
export const MAX_STORE_PAYMENT_DOMAINS = 20;

const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function hostOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim().toLowerCase();
  let host = value;
  if (value.includes('://')) {
    try { host = new URL(value).hostname; } catch { return null; }
  }
  host = host.replace(/\.$/, '');
  if (!HOSTNAME.test(host) || IPV4.test(host) || host === 'localhost' || host.endsWith('.localhost')) return null;
  return host;
}

/**
 * The web domains a store's storefront is served on, from its own configuration (never another store's env default):
 * the host of `config.storefrontUrl` plus every `config.hostnames` entry. A bare hostname entry also covers its `www.`
 * form, because the store resolver matches subdomains of an entry while a wallet domain registration is exact.
 * Loopback, IP and single-label hosts are skipped (wallets need a public HTTPS domain).
 */
export function storePaymentDomains(config: unknown): string[] {
  const cfg = (config && typeof config === 'object' ? config : {}) as { storefrontUrl?: unknown; hostnames?: unknown };
  const out: string[] = [];
  const add = (host: string | null) => { if (host && !out.includes(host)) out.push(host); };
  add(hostOf(cfg.storefrontUrl));
  for (const entry of Array.isArray(cfg.hostnames) ? cfg.hostnames : []) {
    const host = hostOf(entry);
    add(host);
    if (host && !host.startsWith('www.')) add(`www.${host}`);
  }
  return out.slice(0, MAX_STORE_PAYMENT_DOMAINS);
}

function walletStatus(v: { status?: string } | null | undefined): WalletDomainStatus {
  return v?.status === 'active' ? 'active' : v?.status === 'inactive' ? 'inactive' : 'unknown';
}

function describe(pmd: PaymentMethodDomainLike, outcome: DomainRegistration['outcome']): DomainRegistration {
  return { domain: pmd.domain_name, id: pmd.id, outcome, enabled: pmd.enabled, applePay: walletStatus(pmd.apple_pay), googlePay: walletStatus(pmd.google_pay) };
}

export async function ensurePaymentMethodDomains(client: StripePaymentMethodDomainClient, domains: readonly string[]): Promise<DomainRegistration[]> {
  const results: DomainRegistration[] = [];
  for (const domain of domains) {
    try {
      const { data } = await client.paymentMethodDomains.list({ domain_name: domain, limit: 1 });
      const existing = data.find((d) => d.domain_name === domain);
      if (!existing) {
        results.push(describe(await client.paymentMethodDomains.create({ domain_name: domain, enabled: true }), 'created'));
        continue;
      }
      if (!existing.enabled) {
        results.push(describe(await client.paymentMethodDomains.update(existing.id, { enabled: true }), 'updated'));
        continue;
      }
      if (walletStatus(existing.apple_pay) !== 'active') {
        // Re-checks the payment methods' requirements for an already-registered domain (e.g. it was registered before
        // the site went live on it).
        results.push(describe(await client.paymentMethodDomains.validate(existing.id), 'updated'));
        continue;
      }
      results.push(describe(existing, 'unchanged'));
    } catch (e) {
      results.push({ domain, id: null, outcome: 'failed', enabled: false, applePay: 'unknown', googlePay: 'unknown', error: e instanceof Error ? e.message : 'registration failed' });
    }
  }
  return results;
}
