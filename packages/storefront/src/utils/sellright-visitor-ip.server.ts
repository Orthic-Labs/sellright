/**
 * Server-only: the real visitor IP for the storefront's server-side relays of public forms (newsletter, contact).
 * The storefront posts those to the SellRight API itself, so without this every visitor shares the storefront's own
 * address and the API's per-IP limits (contact 5/hr, newsletter 5/hr) would throttle the whole site at once.
 *
 * The IP is forwarded in `x-real-ip`, the header the API honours (TRUSTED_PROXY_HEADER, default x-real-ip) ONLY when
 * the connection comes from a proxy the deployment controls (auth/rate-limit.ts pickClientIp). A browser can never
 * set it for the API: public traffic reaches the API through nginx, which overwrites x-real-ip, and a direct public
 * peer's header is ignored. On this side the visitor IP comes from the socket, or from the incoming `x-real-ip`
 * only when the deployment declares a trusted proxy with SELLRIGHT_TRUST_FORWARDED_HOST=1 (the same switch, and the
 * same "proxy overwrites the forwarded headers" contract, as utils/trusted-request.server.ts). X-Forwarded-For is
 * never read. `.server.ts` is stripped from the client bundle; callers stay behind `isServer`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { VISITOR_IP_HEADER } from './visitor-ip-header';

export { VISITOR_IP_HEADER };

export const sellrightVisitorIp = new AsyncLocalStorage<string | undefined>();

type HeaderValue = string | string[] | null | undefined;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

/** A bare IP literal (IPv4-mapped IPv6 unwrapped), or undefined. Never anything a header could smuggle in. */
export function cleanIp(raw: HeaderValue): string | undefined {
	let v = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim() ?? '';
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v);
	if (mapped) v = mapped[1]!;
	if (v.length > 45) return undefined;
	if (IPV4.test(v)) return v.split('.').every((o) => Number(o) <= 255) ? v : undefined;
	return v.includes(':') && IPV6.test(v) ? v : undefined;
}

/** The visitor IP for one request: the proxy's x-real-ip when a trusted proxy is declared, else the socket peer. */
export function resolveVisitorIp(
	req: { headers: { get(name: string): string | null }; socketIp?: string },
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	if (env.SELLRIGHT_TRUST_FORWARDED_HOST === '1') {
		const fromProxy = cleanIp(req.headers.get(VISITOR_IP_HEADER));
		if (fromProxy) return fromProxy;
	}
	return cleanIp(req.socketIp);
}

/** Run `fn` so every sr() call inside it forwards this request's visitor IP to the API. */
export function withVisitorIp<T>(
	event: { request: { headers: { get(name: string): string | null } }; clientConn?: { ip?: string } },
	fn: () => Promise<T>,
): Promise<T> {
	return sellrightVisitorIp.run(resolveVisitorIp({ headers: event.request.headers, socketIp: event.clientConn?.ip }), fn);
}
