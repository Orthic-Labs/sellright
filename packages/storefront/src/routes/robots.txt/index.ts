import type { RequestHandler } from '@qwik.dev/router';

export const onGet: RequestHandler = async ({ send, headers }) => {
  try {
    const response = await fetch('http://localhost:3100/seo/robots.txt', {
      method: 'GET',
      headers: { 'Accept': 'text/plain' },
    });

    if (!response.ok) {
      throw new Error(`Backend returned ${response.status}`);
    }

    const robotsTxt = await response.text();

    if (robotsTxt.includes('<!DOCTYPE') || robotsTxt.includes('<html')) {
      throw new Error('Backend returned HTML instead of robots.txt');
    }

    headers.set('Content-Type', 'text/plain; charset=utf-8');
    headers.set('Cache-Control', 'public, max-age=86400');
    send(200, robotsTxt);

  } catch (error) {
    console.error('Error fetching robots.txt from backend:', error);

    const fallbackRobots = `# Robots.txt for Damned Designs
User-agent: *
Allow: /
Disallow: /admin/
Disallow: /admin-api/
Disallow: /shop-api/
Disallow: /checkout/
Disallow: /account/
Disallow: /search
Disallow: /api/
Disallow: /cart
Disallow: /sign-in
Disallow: /forgot-password
Disallow: /password-reset
Disallow: /verify
Disallow: /cache/
Disallow: /cache-admin/

User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: Googlebot-Image
Allow: /

User-agent: Bingbot
Crawl-delay: 2

User-agent: AhrefsBot
Disallow: /

User-agent: MJ12bot
Disallow: /

User-agent: DotBot
Disallow: /

User-agent: SemrushBot
Disallow: /

User-agent: MauiBot
Disallow: /

Sitemap: https://www.damneddesigns.com/sitemap.xml`;

    headers.set('Content-Type', 'text/plain; charset=utf-8');
    headers.set('Cache-Control', 'public, max-age=3600');
    send(200, fallbackRobots);
  }
};
