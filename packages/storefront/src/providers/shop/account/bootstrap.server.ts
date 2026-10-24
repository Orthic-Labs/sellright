/** SSR adopts only API-validated credentials & forwards cookie adoption before rendering. */
import { sellright } from '~/sellright/client';

const SHARED_KEY = 'sellright:auth-bootstrap';

/**
 * Resolve the session once per request (#362): the /account guard (onRequest) and the root auth loader both need it on
 * the same request. Pass the request's `sharedMap` (Qwik's per-request store) to share the one /auth/me read between
 * them; it never outlives the request. Without a map every call reads.
 */
export function bootstrapCustomer(headers: Pick<Headers, 'append'>, sharedMap?: Map<string, unknown>) {
  if (!sharedMap) return readCustomer(headers);
  let read = sharedMap.get(SHARED_KEY) as ReturnType<typeof readCustomer> | undefined;
  if (!read) {
    read = readCustomer(headers);
    sharedMap.set(SHARED_KEY, read);
  }
  return read;
}

async function readCustomer(headers: Pick<Headers, 'append'>) {
  const { data, response } = await sellright().GET('/v1/shop/auth/me');
  if (!data) throw new Error('Empty auth bootstrap response');
  for (const value of response.headers.getSetCookie()) headers.append('Set-Cookie', value);
  return data;
}
