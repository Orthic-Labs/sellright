import { OpenAPIHono } from '@hono/zod-openapi';

/**
 * Apple App Site Association for iOS Password AutoFill (webcredentials).
 * A storefront's iOS app declares `webcredentials:<domain>`; iOS fetches this
 * file to confirm the app belongs to the domain before offering saved
 * credentials. Served here (not a static file) so the Content-Type is
 * application/json, which Apple requires.
 *
 * AASA_APP_IDS: comma-separated `<TeamID>.<bundle id>` list. Unset -> 404,
 * so deployments without a mobile app expose nothing.
 */
export const wellKnown = new OpenAPIHono();

wellKnown.get('/.well-known/apple-app-site-association', (c) => {
  const ids = (process.env.AASA_APP_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ webcredentials: { apps: ids } }, 200);
});
