export type GatewayMode = 'test' | 'live';
export type GatewayMethod = 'nmi' | 'sezzle';

/** Secrets come from server configuration. Only identity fields enter the ledger. */
export interface GatewayAccount {
  accountId: string;
  storeId: string;
  method: GatewayMethod;
  mode: GatewayMode;
  nmiEnvironment?: 'sandbox' | 'production';
  securityKey?: string;
  tokenizationKey?: string;
  publicKey?: string;
  privateKey?: string;
}

export interface GatewayIdentity {
  accountId: string;
  storeId: string;
  method: GatewayMethod;
  mode: GatewayMode;
  nmiEnvironment?: 'sandbox' | 'production';
}

const GatewayAccountSchema = z.object({
  accountId: z.string().trim().min(1).max(128),
  storeId: z.string().uuid(),
  method: z.enum(['nmi', 'sezzle']),
  mode: z.enum(['test', 'live']),
  nmiEnvironment: z.enum(['sandbox', 'production']).optional(),
  securityKey: z.string().min(1).optional(),
  tokenizationKey: z.string().min(1).optional(),
  publicKey: z.string().min(1).optional(),
  privateKey: z.string().min(1).optional(),
}).strict().refine((account) => !account.nmiEnvironment ||
  (account.method === 'nmi' && (account.mode === 'test' || account.nmiEnvironment === 'production')),
{ message: 'NMI environment must match the account method and mode' });

export function nmiEnvironment(account: GatewayAccount): 'sandbox' | 'production' {
  return account.nmiEnvironment ?? (account.mode === 'test' ? 'sandbox' : 'production');
}

export function recordedNmiEnvironment(identity: unknown, mode: string): 'sandbox' | 'production' {
  if (mode !== 'test' && mode !== 'live') throw new Error('Invalid original NMI mode');
  const recorded = (identity as { nmiEnvironment?: unknown } | null)?.nmiEnvironment;
  if (recorded == null) return mode === 'test' ? 'sandbox' : 'production';
  if (recorded !== 'sandbox' && recorded !== 'production') throw new Error('Invalid original NMI environment');
  return recorded;
}

/** Refuse to move historical operations when an operator edits the current profile. */
export function assertGatewayEnvironment(account: GatewayAccount, originalIdentity: unknown): void {
  if (account.method === 'nmi' && nmiEnvironment(account) !== recordedNmiEnvironment(originalIdentity, account.mode)) {
    throw new Error('Original NMI environment does not match the configured account');
  }
}

function parseGatewayAccounts(source: string): GatewayAccount[] {
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { throw new Error('Invalid gateway account configuration'); }
  const parsed = z.array(GatewayAccountSchema).safeParse(raw);
  if (!parsed.success) throw new Error('Invalid gateway account configuration');
  const identities = new Set<string>();
  for (const account of parsed.data) {
    const identity = `${account.storeId}:${account.method}:${account.accountId}:${account.mode}`;
    if (identities.has(identity)) throw new Error('Duplicate gateway account identity');
    identities.add(identity);
  }
  return parsed.data;
}

export function gatewayIdentity(account: GatewayAccount): GatewayIdentity {
  return {
    accountId: account.accountId, storeId: account.storeId,
    method: account.method, mode: account.mode,
    ...(account.method === 'nmi' ? { nmiEnvironment: nmiEnvironment(account) } : {}),
  };
}

/** Profiles are immutable account+mode identities. Rotate secrets, never repurpose IDs. */
export function gatewayAccount(
  storeId: string,
  method: GatewayMethod,
  accountId: string,
  mode?: GatewayMode,
  source = env.GATEWAY_ACCOUNTS_JSON,
): GatewayAccount {
  const profiles = parseGatewayAccounts(source);
  const matches = profiles.filter((p): p is GatewayAccount =>
    !!p && p.accountId === accountId && p.storeId === storeId && p.method === method &&
    (p.mode === 'test' || p.mode === 'live') && (!mode || p.mode === mode));
  if (matches.length !== 1) throw new Error('Gateway account is not configured for this store and mode');
  const profile = matches[0]!;
  if (method === 'nmi' && !profile.securityKey) throw new Error('NMI security key is not configured');
  if (method === 'sezzle' && (!profile.publicKey || !profile.privateKey)) throw new Error('Sezzle keys are not configured');
  return profile;
}

export function configuredGatewayAccount(storeId: string, method: GatewayMethod, config: unknown): GatewayAccount {
  const id = (config as { paymentAccounts?: Record<string, unknown> } | null)?.paymentAccounts?.[method];
  if (typeof id !== 'string' || !id) throw new Error('Gateway account selection is missing');
  return gatewayAccount(storeId, method, id);
}

/** Marker accountId for a GatewayAccount assembled from the encrypted
 *  `store_secret` table (WS-A) rather than GATEWAY_ACCOUNTS_JSON. Never a
 *  real env-configured accountId (those are merchant-chosen strings), so it
 *  safely round-trips through paymentAttempt.accountId to identify, on
 *  reconciliation, which resolution path to use again. */
export const DB_ACCOUNT_ID = 'db';

/** Per-store, per-method mode selector for the DB-backed (one-click install)
 *  path — the NMI/Sezzle analogue of stripeModeFromConfig(). Defaults to
 *  'test' (fail-safe) until a store explicitly flips to live. */
export function gatewayModeFromConfig(config: unknown, method: GatewayMethod): GatewayMode {
  // `payments.<method>` may be a legacy boolean (`true` → default test mode)
  // or `{ enabled, mode }` — see provider.ts paymentMethodSetting().
  const raw = (config as { payments?: Record<string, unknown> } | null | undefined)?.payments?.[method];
  const m = raw && typeof raw === 'object' ? (raw as { mode?: unknown }).mode : undefined;
  return m === 'live' ? 'live' : 'test';
}

/** The admin Payments settings page stores Sezzle credentials under the
 *  provider's own spelling (`sandbox` / `production`), while the runtime
 *  resolver and store.config.payments.sezzle.mode speak `test` / `live`.
 *  Rows are sealed with their mode string in the encryption purpose, so each
 *  spelling is read under its own scope: the admin spelling first, then the
 *  legacy `test`/`live` spelling that staged stores may already hold. */
export function sezzleSecretModes(mode: GatewayMode | string): string[] {
  if (mode === 'test' || mode === 'sandbox') return ['sandbox', 'test'];
  if (mode === 'live' || mode === 'production') return ['production', 'live'];
  return [mode];
}

export async function resolveSezzleField(tx: Tx, storeId: string, mode: GatewayMode | string, field: string) {
  let last = { value: '', source: 'unset' as 'env' | 'db' | 'unset' };
  for (const m of sezzleSecretModes(mode)) {
    const r = await resolveField(tx, { storeId, provider: 'sezzle', mode: m, field }, undefined);
    if (r.value) return r;
    last = r;
  }
  return last;
}

async function dbGatewayAccount(tx: Tx, storeId: string, method: GatewayMethod, mode: GatewayMode): Promise<GatewayAccount> {
  if (method === 'nmi') {
    const securityKey = await resolveField(tx, { storeId, provider: 'nmi', mode, field: 'securityKey' }, undefined);
    const tokenizationKey = await resolveField(tx, { storeId, provider: 'nmi', mode, field: 'tokenizationKey' }, undefined);
    // A signing secret for NMI's chargeback webhook (routes/disputes.ts) reuses
    // the shared `privateKey` field, same as Sezzle's HMAC key — see that
    // route's doc comment. Optional: absence just means chargebacks aren't wired.
    const privateKey = await resolveField(tx, { storeId, provider: 'nmi', mode, field: 'privateKey' }, undefined);
    if (!securityKey.value) throw new Error('NMI security key is not configured');
    return {
      accountId: DB_ACCOUNT_ID, storeId, method: 'nmi', mode,
      securityKey: securityKey.value,
      tokenizationKey: tokenizationKey.value || undefined,
      privateKey: privateKey.value || undefined,
    };
  }
  const publicKey = await resolveSezzleField(tx, storeId, mode, 'publicKey');
  const privateKey = await resolveSezzleField(tx, storeId, mode, 'privateKey');
  if (!publicKey.value || !privateKey.value) throw new Error('Sezzle keys are not configured');
  return { accountId: DB_ACCOUNT_ID, storeId, method: 'sezzle', mode, publicKey: publicKey.value, privateKey: privateKey.value };
}

/**
 * WS-A env>db resolution for a NAMED account (reconciliation call sites that
 * already know accountId+mode from a persisted paymentAttempt row). An
 * accountId other than DB_ACCOUNT_ID takes the unchanged env path
 * (GATEWAY_ACCOUNTS_JSON) exactly as before — existing deployments are
 * unaffected. DB_ACCOUNT_ID resolves the mode's credentials from
 * `store_secret`, scoped to `storeId` under RLS (own short-lived transaction —
 * callers of this function are, by design, never inside an open tx while a
 * gateway/network call is pending).
 */
export async function resolveGatewayAccount(
  storeId: string, method: GatewayMethod, accountId: string, mode?: GatewayMode,
): Promise<GatewayAccount> {
  if (accountId !== DB_ACCOUNT_ID) return gatewayAccount(storeId, method, accountId, mode);
  if (!mode) throw new Error('mode is required to resolve a DB-backed gateway account');
  return withStore(storeId, (tx) => dbGatewayAccount(tx, storeId, method, mode));
}

/**
 * WS-A env>db resolution for the store's CONFIGURED account for `method`
 * (checkout-time). An env account selected via config.paymentAccounts[method]
 * takes the unchanged path; otherwise falls back to the DB-backed account for
 * the store's configured mode (gatewayModeFromConfig).
 */
export async function resolveConfiguredGatewayAccount(storeId: string, method: GatewayMethod, config: unknown): Promise<GatewayAccount> {
  const id = (config as { paymentAccounts?: Record<string, unknown> } | null)?.paymentAccounts?.[method];
  if (typeof id === 'string' && id) return gatewayAccount(storeId, method, id);
  const mode = gatewayModeFromConfig(config, method);
  return withStore(storeId, (tx) => dbGatewayAccount(tx, storeId, method, mode));
}

export function validGatewayInput(
  input: { storeId?: string; amount: number; currency: string; gateway?: GatewayAccount },
  method: GatewayMethod,
): boolean {
  return !!input.gateway && input.gateway.method === method &&
    (!input.storeId || input.storeId === input.gateway.storeId) &&
    Number.isSafeInteger(input.amount) && input.amount > 0 &&
    input.currency === 'USD';
}

export type GatewayFetch = typeof fetch;

export async function boundedGatewayResponse(response: Response): Promise<string> {
  if (!response.ok) throw new Error('Gateway request did not return success');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Gateway returned an empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_048_576) throw new Error('Gateway response exceeds limit');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks).toString('utf8');
}
import { z } from 'zod';
import { env } from '../env.js';
import { withStore, type Tx } from '../db/client.js';
import { resolveField } from '../security/settings-resolver.js';
