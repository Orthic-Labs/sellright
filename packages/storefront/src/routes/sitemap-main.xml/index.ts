import type { RequestHandler } from '@qwik.dev/router';

/**
 * Main sitemap proxy route
 * Proxies the main sitemap (static pages) from the backend SEO service
 */
export const onGet: RequestHandler = async ({ send, headers }) => {
  try {
    // Direct fetch to backend (server$ functions had issues in production)
    const backendUrl = 'http://localhost:3100/seo/sitemap-main.xml';

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
    headers.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    send(200, xmlData);

  } catch (error) {
    console.error('[sitemap-main] Error:', error);

    // Return fallback sitemap if backend is unavailable
    const fallbackSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://www.damneddesigns.com/</loc>
  </url>
  <url>
    <loc>https://www.damneddesigns.com/shop</loc>
  </url>
  <url>
    <loc>https://www.damneddesigns.com/contact</loc>
  </url>
  <url>
    <loc>https://www.damneddesigns.com/returns</loc>
  </url>
  <url>
    <loc>https://www.damneddesigns.com/privacy</loc>
  </url>
  <url>
    <loc>https://www.damneddesigns.com/terms</loc>
  </url>
</urlset>`;

    headers.set('Content-Type', 'application/xml');
    headers.set('Cache-Control', 'public, max-age=300');
    send(500, fallbackSitemap);
  }
};
