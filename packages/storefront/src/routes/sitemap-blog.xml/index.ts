import type { RequestHandler } from '@qwik.dev/router';

/**
 * Blog sitemap proxy route
 * Proxies the blog sitemap from the backend SEO service
 */
export const onGet: RequestHandler = async ({ send, headers }) => {
  try {
    const backendUrl = 'http://localhost:3100/seo/sitemap-blog.xml';

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
    headers.set('Cache-Control', 'public, max-age=1800');
    send(200, xmlData);

  } catch (error) {
    console.error('[sitemap-blog] Error:', error);

    const errorSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <!-- Error loading blog posts -->
</urlset>`;

    headers.set('Content-Type', 'application/xml');
    headers.set('Cache-Control', 'public, max-age=300');
    send(500, errorSitemap);
  }
};
