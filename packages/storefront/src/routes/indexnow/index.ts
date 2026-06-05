import type { RequestHandler } from '@qwik.dev/router';

const INDEXNOW_KEY = 'c7f8a2b4e91d3f6a';

export const onGet: RequestHandler = async ({ send, headers, url }) => {
  const urlParam = url.searchParams.get('url');
  const _keyParam = url.searchParams.get('key');

  // If called without params, return the key for verification
  if (!urlParam) {
    headers.set('Content-Type', 'text/plain');
    send(200, INDEXNOW_KEY);
    return;
  }

  // Submit URL to IndexNow
  try {
    const payload = {
      host: 'www.damneddesigns.com',
      key: INDEXNOW_KEY,
      keyLocation: 'https://www.damneddesigns.com/c7f8a2b4e91d3f6a.txt',
      urlList: urlParam.split(',').map(u => u.trim()),
    };

    const response = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    headers.set('Content-Type', 'application/json');
    send(response.status, JSON.stringify({
      success: response.ok,
      status: response.status,
      submitted: payload.urlList.length,
    }));
  } catch (error) {
    headers.set('Content-Type', 'application/json');
    send(500, JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
};
