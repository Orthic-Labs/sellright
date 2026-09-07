export type GatewayMode = 'test' | 'live';
export type GatewayMethod = 'nmi' | 'sezzle';

/** Secrets come from server configuration. Only identity fields enter the ledger. */
export interface GatewayAccount {
  accountId: string;
  storeId: string;
  method: GatewayMethod;
  mode: GatewayMode;
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
}

export function gatewayIdentity(account: GatewayAccount): GatewayIdentity {
  return {
    accountId: account.accountId, storeId: account.storeId,
    method: account.method, mode: account.mode,
  };
}

/** Profiles are immutable account+mode identities. Rotate secrets, never repurpose IDs. */
export function gatewayAccount(
  storeId: string,
  method: GatewayMethod,
  accountId: string,
  mode?: GatewayMode,
  source = process.env.GATEWAY_ACCOUNTS_JSON,
): GatewayAccount {
  let profiles: unknown;
  try { profiles = JSON.parse(source ?? '[]'); } catch { throw new Error('Invalid gateway account configuration'); }
  if (!Array.isArray(profiles)) throw new Error('Invalid gateway account configuration');
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
