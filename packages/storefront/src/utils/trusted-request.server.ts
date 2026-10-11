/**
 * Request host/origin taken from the ONE trusted boundary the storefront recognises: the connection's own Host and
 * socket, plus the forwarded host/protocol headers only when the deployment declares a trusted proxy with
 * `SELLRIGHT_TRUST_FORWARDED_HOST=1` (set only when that proxy overwrites X-Forwarded-Host and X-Forwarded-Proto).
 * Nothing else may read a forwarded header. SERVER-ONLY.
 */
import { newsletterRequestHost } from '~/services/listmonk.server';

type HeaderValue = string | string[] | undefined;
type NodeHeaders = Record<string, HeaderValue>;

const first = (v: HeaderValue): string => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim() ?? '';

/** Request host without port, validated; '' when unusable. Forwarded host honoured only for a trusted proxy. */
export function validatedRequestHost(headers: NodeHeaders, env: Record<string, string | undefined> = process.env): string {
	return newsletterRequestHost({ host: first(headers.host), forwardedHost: first(headers['x-forwarded-host']) }, env);
}

const HOST_WITH_PORT = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;
const hostWithPort = (v: HeaderValue): string => {
	const h = first(v).toLowerCase();
	return HOST_WITH_PORT.test(h) ? h : '';
};

/**
 * The origin the framework should treat as this request's own (its form-POST check compares the browser's `Origin`
 * header with it). Behind an HTTPS-terminating proxy the socket is plain http and the Host may be internal, so the
 * default origin never matches the browser's. Returns undefined (framework default: the socket + Host) unless the
 * deployment declares a trusted proxy; then the forwarded protocol (http|https only) and forwarded host win, each
 * falling back to the socket/Host when absent or malformed.
 */
export function trustedRequestOrigin(
	req: { headers: NodeHeaders; socket?: object },
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	if (env.SELLRIGHT_TRUST_FORWARDED_HOST !== '1') return undefined;
	const proto = first(req.headers['x-forwarded-proto']).toLowerCase();
	const forwardedProto = proto === 'https' || proto === 'http' ? proto : '';
	const forwardedHost = hostWithPort(req.headers['x-forwarded-host']);
	if (!forwardedProto && !forwardedHost) return undefined;
	const host = forwardedHost || hostWithPort(req.headers.host);
	if (!host) return undefined;
	return `${forwardedProto || ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? 'https' : 'http')}://${host}`;
}
