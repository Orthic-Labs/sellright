import { createHmac, timingSafeEqual } from 'node:crypto';

type Config = { host?: string; key?: string; keyLocation?: string; secret?: string; storeId?: string };
const MAX_BODY = 16 * 1024;

export async function handleIndexNowWebhook(request: Request, config: Config, submit: typeof fetch = fetch): Promise<Response> {
  const reply = (status: number, error: string) => Response.json({ success: false, error }, { status });
  const { host, key, secret, storeId } = config;
  let keyLocation: string;
  try {
    if (!host || !key || !secret || !storeId || !/^[a-z0-9.-]+$/i.test(host) || !/^[a-z0-9-]{8,128}$/i.test(key)) throw new Error();
    const location = new URL(config.keyLocation || `https://${host}/${key}.txt`);
    if (location.protocol !== 'https:' || location.host !== host || location.username || location.password) throw new Error();
    keyLocation = location.href;
  } catch { return reply(503, 'IndexNow webhook is not configured'); }

  const signature = request.headers.get('x-sr-signature') ?? '';
  if (!/^[a-f0-9]{64}$/.test(signature)) return reply(403, 'Invalid signature');
  if (request.headers.get('x-sr-topic') !== 'catalog.product_changed') return reply(400, 'Unsupported topic');
  if (Number(request.headers.get('content-length')) > MAX_BODY) return reply(413, 'Payload too large');
  const reader = request.body?.getReader();
  if (!reader) return reply(400, 'Missing payload');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BODY) { await reader.cancel(); return reply(413, 'Payload too large'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const raw = Buffer.concat(chunks);
  const expected = createHmac('sha256', secret!).update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return reply(403, 'Invalid signature');
  let slug: string;
  try {
    const event = JSON.parse(raw.toString('utf8'));
    if (event.topic !== 'catalog.product_changed' || event.payload?.storeId !== storeId) return reply(403, 'Wrong store or topic');
    slug = event.payload.slug;
    if (typeof slug !== 'string' || !slug.trim() || slug.length > 2000 || slug === '.' || slug === '..') throw new Error();
  } catch { return reply(400, 'Invalid payload'); }

  try {
    const result = await submit('https://api.indexnow.org/indexnow', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, key, keyLocation, urlList: [`https://${host}/products/${encodeURIComponent(slug)}/`] }),
      signal: AbortSignal.timeout(8000),
    });
    if (result.status !== 200 && result.status !== 202) return reply(502, 'IndexNow did not accept the submission');
    return Response.json({ success: true, submitted: 1, status: result.status });
  } catch { return reply(502, 'IndexNow submission failed'); }
}
