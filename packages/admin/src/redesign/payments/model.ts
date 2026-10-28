/** #406 Payments settings model: wire types from GET /payments/settings and GET /settings/store, and the derived state. */

export type Provider = 'stripe' | 'nmi' | 'sezzle';
export type KeyMode = 'test' | 'live';

export interface FieldStatus { envManaged: boolean; configured: boolean; last4: string | null }
/** `{ provider: { 'test:secretKey': FieldStatus, ... } }`. Sezzle modes are spelled sandbox/production on the wire. */
export type CredStatus = Record<string, Record<string, FieldStatus>>;
export interface StoreSettings { payments?: Record<string, unknown>; stripeMode?: KeyMode }

export interface FieldDef {
  key: string;
  label: string;
  /** The verify endpoint checks this field against the provider before it is saved. */
  tested: boolean;
}

export interface ProviderDef {
  id: Provider;
  name: string;
  logo: string;
  blurb: string;
  /** Credential fields shown as key rows. */
  keys: FieldDef[];
  /** Keys that must exist for the mode in use before Activate is offered. */
  required: string[];
  modeLabel: Record<KeyMode, string>;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'nmi', name: 'NMI', logo: 'N', blurb: 'Card payments at checkout',
    keys: [{ key: 'securityKey', label: 'Security key', tested: true }, { key: 'tokenizationKey', label: 'Collect.js tokenization key', tested: false }],
    required: ['securityKey', 'tokenizationKey'], modeLabel: { test: 'Test', live: 'Live' },
  },
  {
    id: 'stripe', name: 'Stripe', logo: 'S', blurb: 'Cards, Apple Pay, Google Pay',
    keys: [{ key: 'publishableKey', label: 'Publishable key', tested: false }, { key: 'secretKey', label: 'Secret key', tested: true }],
    required: ['publishableKey', 'secretKey'], modeLabel: { test: 'Test', live: 'Live' },
  },
  {
    id: 'sezzle', name: 'Sezzle', logo: 'Sz', blurb: 'Pay in 4 at checkout',
    keys: [{ key: 'publicKey', label: 'Public key', tested: true }, { key: 'privateKey', label: 'Private key', tested: true }],
    required: ['publicKey', 'privateKey'], modeLabel: { test: 'Sandbox', live: 'Production' },
  },
];

export const NMI_WEBHOOK: FieldDef = { key: 'privateKey', label: 'Chargeback webhook signing secret', tested: false };
export const STRIPE_WEBHOOK: FieldDef = { key: 'webhookSecret', label: 'Webhook signing secret', tested: false };

/** `payments.<method>` is either a legacy boolean or `{ enabled, mode, <mode>: { verifiedAt } }`. */
export function providerEnabled(v: unknown): boolean {
  return v === true || (!!v && typeof v === 'object' && (v as { enabled?: unknown }).enabled === true);
}

/** The key set checkout really uses. Stripe keeps its mode at stripeMode; NMI and Sezzle at payments.<p>.mode. */
export function modeInUse(p: Provider, s: StoreSettings): KeyMode {
  if (p === 'stripe') return s.stripeMode === 'live' ? 'live' : 'test';
  const v = s.payments?.[p];
  return v && typeof v === 'object' && (v as { mode?: unknown }).mode === 'live' ? 'live' : 'test';
}

/** The mode spelling the credentials endpoints use. */
export function wireMode(p: Provider, m: KeyMode): string {
  return p === 'sezzle' ? (m === 'live' ? 'production' : 'sandbox') : m;
}

export function fieldStatus(creds: CredStatus, p: Provider, m: KeyMode, field: string): FieldStatus | undefined {
  return creds[p]?.[`${wireMode(p, m)}:${field}`];
}

export function hasKeys(creds: CredStatus, def: ProviderDef, m: KeyMode): boolean {
  return def.required.every((f) => fieldStatus(creds, def.id, m, f)?.configured);
}

/** ISO time of the last passed connection test for this mode, if any. */
export function lastVerified(p: Provider, m: KeyMode, s: StoreSettings): string | null {
  const v = s.payments?.[p];
  const per = v && typeof v === 'object' ? (v as Record<string, unknown>)[wireMode(p, m)] : undefined;
  const at = per && typeof per === 'object' ? (per as { verifiedAt?: unknown }).verifiedAt : undefined;
  return typeof at === 'string' ? at : null;
}

export const maskedKey = (last4: string | null) => (last4 ? `•••••••••••• ${last4}` : '••••••••••••');

/** Response of POST /payments/settings/{provider}/{mode}/verify. `tested: 'candidate'` is the API confirming it checked the supplied key, not the saved one. */
export interface VerifyResult { ok: boolean; error?: string; tested?: 'candidate' | 'saved' }
