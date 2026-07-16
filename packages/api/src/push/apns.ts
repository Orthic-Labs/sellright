/**
 * APNs client — dependency-free (node:http2 + node:crypto).
 *
 * Why no library: the two common ones (`node-apn`, `@parse/node-apn`) are
 * thin wrappers over exactly this, and the whole surface we need is "sign an
 * ES256 JWT, POST one JSON body over HTTP/2". Adding a dependency to a repo
 * that currently audits clean, for ~120 lines, isn't a trade worth making.
 *
 * Auth is token-based (.p8 key), NOT certificate-based: one key works for every
 * app and never expires, where certs are per-app and expire annually. The JWT is
 * cached and refreshed hourly — Apple rejects tokens older than 1h and
 * rate-limits clients that mint a fresh one per push.
 *
 * The .p8 private key lives in env (APNS_KEY_P8), never in the repo.
 */
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { createSign } from 'node:crypto';
import { env } from '../env.js';

const HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;

export type ApnsEnvironment = keyof typeof HOSTS;

/** Apple rejects a provider token older than 1h; refresh at 50m for headroom. */
const TOKEN_TTL_MS = 50 * 60 * 1000;

export interface ApnsResult {
  ok: boolean;
  status: number;
  /** Apple's `reason` string, e.g. 'BadDeviceToken', 'Unregistered'. */
  reason?: string;
  /** True when the token is dead and the row must be deleted, not retried. */
  unregistered: boolean;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let cachedToken: { jwt: string; mintedAt: number } | null = null;

/**
 * ES256-signed provider token. `iss` is the team id, `kid` the key id — both
 * from the Apple developer account alongside the .p8.
 */
export function mintProviderToken(now = Date.now()): string {
  if (cachedToken && now - cachedToken.mintedAt < TOKEN_TTL_MS) return cachedToken.jwt;

  const keyId = env.APNS_KEY_ID;
  const teamId = env.APNS_TEAM_ID;
  const p8 = env.APNS_KEY_P8;
  if (!keyId || !teamId || !p8) throw new Error('APNs not configured (APNS_KEY_ID / APNS_TEAM_ID / APNS_KEY_P8)');

  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
  const signer = createSign('SHA256');
  signer.update(`${header}.${claims}`);
  // Env vars can't hold real newlines; accept the \n-escaped form too.
  const pem = p8.includes('\\n') ? p8.replace(/\\n/g, '\n') : p8;
  const signature = base64url(signer.sign({ key: pem, dsaEncoding: 'ieee-p1363' }));

  const jwt = `${header}.${claims}.${signature}`;
  cachedToken = { jwt, mintedAt: now };
  return jwt;
}

/** Drop the cached provider token (tests, and key rotation). */
export function resetProviderToken(): void {
  cachedToken = null;
}

/**
 * Push one notification. Opens a short-lived HTTP/2 session per call — correct
 * but not optimal; APNs prefers a long-lived multiplexed connection. The sender
 * batches per scheduler pass, so this costs one handshake per notification at
 * current volume. Revisit with a pooled session if push volume ever justifies
 * it (the outbox already batches, so the change is local to this file).
 */
export async function sendApns(args: {
  deviceToken: string;
  environment: ApnsEnvironment;
  payload: unknown;
  topic?: string;
  /** APNs push type — 'alert' for user-visible, 'liveactivity' for ActivityKit. */
  pushType?: 'alert' | 'background' | 'liveactivity';
  /** For Live Activity updates: apns-topic gets the .push-type.liveactivity suffix. */
  collapseId?: string;
}): Promise<ApnsResult> {
  const bundleId = env.APNS_BUNDLE_ID;
  if (!bundleId) throw new Error('APNs not configured (APNS_BUNDLE_ID)');

  const jwt = mintProviderToken();
  const host = HOSTS[args.environment];
  const body = JSON.stringify(args.payload);

  let session: ClientHttp2Session | null = null;
  try {
    session = connect(host);
    return await new Promise<ApnsResult>((resolve, reject) => {
      const s = session!;
      s.once('error', reject);

      const headers: Record<string, string> = {
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${args.deviceToken}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': args.topic ?? bundleId,
        'apns-push-type': args.pushType ?? 'alert',
        'content-type': 'application/json',
      };
      if (args.collapseId) headers['apns-collapse-id'] = args.collapseId;

      const req = s.request(headers);
      req.setEncoding('utf8');

      let status = 0;
      let raw = '';
      req.on('response', (h) => { status = Number(h[constants.HTTP2_HEADER_STATUS] ?? 0); });
      req.on('data', (chunk) => { raw += chunk; });
      req.on('error', reject);
      req.on('end', () => {
        // 200 = delivered to Apple. 410 (and 400/BadDeviceToken) = the token is
        // dead: the app was deleted or the token rotated. Retrying it forever
        // would push to nobody and keep a stale row alive — the caller deletes.
        let reason: string | undefined;
        if (raw) { try { reason = (JSON.parse(raw) as { reason?: string }).reason; } catch { /* non-JSON error body */ } }
        resolve({
          ok: status === 200,
          status,
          reason,
          unregistered: status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken',
        });
      });

      req.end(body);
    });
  } finally {
    session?.close();
  }
}

/** True when the APNs env is fully configured; the sender no-ops otherwise. */
export function apnsConfigured(): boolean {
  return Boolean(env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_KEY_P8 && env.APNS_BUNDLE_ID);
}
