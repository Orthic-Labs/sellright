/**
 * PAR-04: SheerID provider adapter. Small seam around the two SheerID calls we
 * make — OAuth client-credentials token + GET verification details — so tests
 * inject a fake transport and never touch the network. Mirrors the DD
 * sheerid-plugin service (plugins/sheerid-plugin/sheerid.service.ts).
 *
 * The default transport is safeOutboundFetch: baseUrl/authUrl come from
 * store-scoped config (admin-supplied), so the SSRF guard applies the same
 * way it does for the Listmonk integration.
 */
import { safeOutboundFetch } from '../security/outbound-url.js';

export type SheerIdTransport = (url: string, init: RequestInit) => Promise<Response>;

/** Store-scoped config — lives at store.config.sheerid. */
export interface SheerIdConfig {
  /** SheerID program id — the {programId} segment of the hosted verify URL. */
  programId?: string;
  /** Hosted-flow theme id (SheerID 'theme' customization slot). */
  theme?: string;
  /** HMAC-SHA256 key for the x-sheerid-signature webhook header. */
  webhookSecret?: string;
  clientId?: string;
  clientSecret?: string;
  /** API base (default https://services.sheerid.com). */
  baseUrl?: string;
  /** OAuth token endpoint (default https://auth.sheerid.com/oauth/token). */
  authUrl?: string;
  /** Hosted verify base (default `${baseUrl}/verify`). */
  verifyBaseUrl?: string;
  /** How long a successful verification stays trusted (default 365 days). */
  verificationTtlDays?: number;
  /** segment → { category, discountPercent }. Missing segment = verification
   *  fails closed (we never grant trusted status for an unknown segment). */
  segments?: Record<string, { category?: string; discountPercent?: number }>;
}

export function sheeridConfig(storeConfig: unknown): SheerIdConfig | null {
  const cfg = (storeConfig as { sheerid?: SheerIdConfig } | null)?.sheerid;
  return cfg && typeof cfg === 'object' ? cfg : null;
}

const DEFAULT_BASE = 'https://services.sheerid.com';
const DEFAULT_AUTH = 'https://auth.sheerid.com/oauth/token';

/** DD parity: the stock SheerID segment → category map. A store's
 *  config.sheerid.segments overrides/extends this. */
export const DEFAULT_SEGMENTS: Record<string, { category: string; discountPercent: number }> = {
  military: { category: 'military', discountPercent: 20 },
  first_responder: { category: 'first_responder', discountPercent: 20 },
  teacher: { category: 'teacher', discountPercent: 15 },
  student: { category: 'student', discountPercent: 15 },
  medical: { category: 'medical', discountPercent: 20 },
  healthcare: { category: 'medical', discountPercent: 20 }, // alternate segment name
  senior: { category: 'senior', discountPercent: 15 },
};

export interface SheerIdVerificationDetails {
  verificationId: string;
  lastResponse?: { currentStep?: string; segment?: string; subSegment?: string } | null;
  personInfo?: { metadata?: Record<string, string> | null } | null;
  [k: string]: unknown;
}

export class SheerIdError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'SheerIdError'; }
}

/** Client-credentials token cache (DD parity: refresh 5 min early). */
export class SheerIdClient {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private cfg: SheerIdConfig,
    private transport: SheerIdTransport = (url, init) => safeOutboundFetch(url, init),
  ) {}

  private async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.token;
    if (!this.cfg.clientId || !this.cfg.clientSecret) {
      throw new SheerIdError('SheerID client credentials are not configured');
    }
    const res = await this.transport(this.cfg.authUrl ?? DEFAULT_AUTH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        audience: 'https://services.sheerid.com/rest/',
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new SheerIdError(`SheerID auth failed: HTTP ${res.status}`, res.status);
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new SheerIdError('SheerID auth returned no access_token');
    this.cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 5 * 60_000 };
    return data.access_token;
  }

  /** GET /rest/v2/verification/{id}/details — authoritative state + personInfo. */
  async getVerificationDetails(verificationId: string): Promise<SheerIdVerificationDetails> {
    const token = await this.accessToken();
    const base = (this.cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    const res = await this.transport(`${base}/rest/v2/verification/${encodeURIComponent(verificationId)}/details`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new SheerIdError(`SheerID verification details failed: HTTP ${res.status}`, res.status);
    return (await res.json()) as SheerIdVerificationDetails;
  }

  /** Hosted verify URL the customer is sent to. metadata.customerId is how the
   *  webhook ties the completed verification back to our customer (DD parity). */
  verificationUrl(programId: string, customerId: string): string {
    const base = (this.cfg.verifyBaseUrl ?? `${(this.cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')}/verify`).replace(/\/+$/, '');
    const url = new URL(`${base}/${encodeURIComponent(programId)}/`);
    url.searchParams.set('metadata', JSON.stringify({ customerId }));
    if (this.cfg.theme) url.searchParams.set('theme', this.cfg.theme);
    return url.toString();
  }
}
