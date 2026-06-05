import type { RequestHandler } from '@qwik.dev/router';

/**
 * Sitemap index proxy route
 * Proxies the sitemap index from the backend SEO service
 */
export const onGet: RequestHandler = async ({ send, headers }) => {
  try {
    // Direct fetch to backend (server$ functions had issues in production)
    const backendUrl = 'http://localhost:3100/seo/sitemap.xml';

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
    console.error('[sitemap.xml] Error:', error);

    console.error('[sitemap.xml] Backend fetch failed, returning fallback sitemap index');

    // Return fallback sitemap index
    const timestamp = new Date().toISOString();
    const fallbackSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://www.damneddesigns.com/sitemap-main.xml</loc>
    <lastmod>${timestamp}</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://www.damneddesigns.com/sitemap-products.xml</loc>
    <lastmod>${timestamp}</lastmod>
  </sitemap>
</sitemapindex>`;

    headers.set('Content-Type', 'application/xml');
    headers.set('Cache-Control', 'public, max-age=300');
    send(200, fallbackSitemap);
  }
};
