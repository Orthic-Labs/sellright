import type { RequestHandler } from '@qwik.dev/router';

export const onGet: RequestHandler = async ({ send, headers }) => {
  try {
    const backendUrl = 'http://localhost:3100/seo/sitemap-collections.xml';

    const response = await fetch(backendUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/xml, text/xml',
        'Cache-Control': 'no-cache'
      }
    });

    if (!response.ok) {
      throw new Error(`Backend returned ${response.status}: ${response.statusText}`);
    }

    const xmlData = await response.text();

    headers.set('Content-Type', 'application/xml');
    headers.set('Cache-Control', 'public, max-age=3600');
    send(200, xmlData);

  } catch (error) {
    console.error('[sitemap-collections] Error:', error);

    // Return valid empty urlset (no collections currently exist)
    const emptySitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>`;

    headers.set('Content-Type', 'application/xml');
    headers.set('Cache-Control', 'public, max-age=3600');
    send(200, emptySitemap);
  }
};
