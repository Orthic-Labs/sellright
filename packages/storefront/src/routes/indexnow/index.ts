import type { RequestHandler } from '@qwik.dev/router';

const INDEXNOW_HOST = (process.env.INDEXNOW_HOST || '').trim().toLowerCase();
const INDEXNOW_KEY = (process.env.INDEXNOW_KEY || '').trim();
const INDEXNOW_KEY_LOCATION =
  (process.env.INDEXNOW_KEY_LOCATION || '').trim() ||
  (INDEXNOW_HOST && INDEXNOW_KEY ? `https://${INDEXNOW_HOST}/${INDEXNOW_KEY}.txt` : '');

function parseUrlList(raw: string | null): string[] {
  if (!raw) return [];
  const items = raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (!items.length || items.length > 100) return [];

  return items.filter((item) => {
    try {
      const parsed = new URL(item);
      return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname === INDEXNOW_HOST;
    } catch {
      return false;
    }
  });
}

export const onGet: RequestHandler = async ({ send, headers, url }) => {
  const urlParam = url.searchParams.get('url');
  const keyParam = url.searchParams.get('key');

  headers.set('Content-Type', 'application/json');

  if (!INDEXNOW_HOST || !INDEXNOW_KEY || !INDEXNOW_KEY_LOCATION) {
    send(503, JSON.stringify({ success: false, error: 'IndexNow is not configured' }));
    return;
  }

  if (keyParam !== INDEXNOW_KEY) {
    send(403, JSON.stringify({ success: false, error: 'Invalid IndexNow key' }));
    return;
  }

  const urlList = parseUrlList(urlParam);
  if (!urlList.length) {
    send(400, JSON.stringify({ success: false, error: 'A valid url parameter is required' }));
    return;
  }

  // Submit URL to IndexNow
  try {
    const payload = {
      host: INDEXNOW_HOST,
      key: INDEXNOW_KEY,
      keyLocation: INDEXNOW_KEY_LOCATION,
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
