/** SSR adopts only API-validated credentials & forwards cookie adoption before rendering. */
import { sellright } from '~/sellright/client';

export async function bootstrapCustomer(headers: Pick<Headers, 'append'>) {
  const { data, response } = await sellright().GET('/v1/shop/auth/me');
  if (!data) throw new Error('Empty auth bootstrap response');
  for (const value of response.headers.getSetCookie()) headers.append('Set-Cookie', value);
  return data;
}
