import type { RequestHandler } from '@qwik.dev/router';
import { handleIndexNowWebhook } from '~/services/indexnow-webhook.server';
import { getIndexNowKey } from '~/services/sellright-seo';

// Host is deployment config (the public domain this storefront serves);
// the KEY VALUE is store config and comes from the backend
// (GET /v1/shop/seo/indexnow-key.txt via getIndexNowKey), never an env var —
// same source of truth as the /{key}.txt key-file route.
const INDEXNOW_HOST = (process.env.INDEXNOW_HOST || '').trim().toLowerCase();

async function resolveIndexNowConfig(): Promise<{ host: string; key: string; keyLocation: string }> {
  const key = (await getIndexNowKey()) ?? '';
  const keyLocation = INDEXNOW_HOST && key ? `https://${INDEXNOW_HOST}/${key}.txt` : '';
  return { host: INDEXNOW_HOST, key, keyLocation };
}

export const onPost: RequestHandler = async ({ request, send }) => {
  const cfg = await resolveIndexNowConfig();
  send(await handleIndexNowWebhook(request, {
    host: cfg.host, key: cfg.key, keyLocation: cfg.keyLocation,
    secret: process.env.INDEXNOW_WEBHOOK_SECRET,
    storeId: process.env.INDEXNOW_STORE_ID,
  }));
};

function parseUrlList(raw: string | null, host: string): string[] {
  if (!raw) return [];
  const items = raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (!items.length || items.length > 100) return [];

  return items.filter((item) => {
    try {
      const parsed = new URL(item);
      return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname === host;
    } catch {
      return false;
    }
  });
}

export const onGet: RequestHandler = async ({ send, headers, url }) => {
  const urlParam = url.searchParams.get('url');
  const keyParam = url.searchParams.get('key');

  headers.set('Content-Type', 'application/json');

  const cfg = await resolveIndexNowConfig();
  if (!cfg.host || !cfg.key || !cfg.keyLocation) {
    send(503, JSON.stringify({ success: false, error: 'IndexNow is not configured' }));
    return;
  }

  if (keyParam !== cfg.key) {
    send(403, JSON.stringify({ success: false, error: 'Invalid IndexNow key' }));
    return;
  }

  const urlList = parseUrlList(urlParam, cfg.host);
  if (!urlList.length) {
    send(400, JSON.stringify({ success: false, error: 'A valid url parameter is required' }));
    return;
  }

  // Submit URL to IndexNow
  try {
    const payload = {
      host: cfg.host,
      key: cfg.key,
      keyLocation: cfg.keyLocation,
      urlList,
    };

    const response = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    send(response.status, JSON.stringify({
      success: response.ok,
      status: response.status,
      submitted: payload.urlList.length,
    }));
  } catch (error) {
    send(500, JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
};
