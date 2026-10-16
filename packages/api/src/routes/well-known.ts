import { OpenAPIHono } from '@hono/zod-openapi';

/**
 * Apple App Site Association for iOS Password AutoFill (webcredentials).
 * A storefront's iOS app declares `webcredentials:<domain>`; iOS fetches this
 * file to confirm the app belongs to the domain before offering saved
 * credentials. Served here (not a static file) so the Content-Type is
 * application/json, which Apple requires.
 *
 * AASA_APP_IDS: comma-separated `<TeamID>.<bundle id>` list. Unset (and no
 * overlay) -> 404, so deployments without a mobile app expose nothing.
 *
 * Overlay (plan 2.6): a plugin's `services` phase calls
 * `ctx.registerAasaOverlay(() => ({ applinks: ..., webcredentials: { apps: [...] } }))`.
 * A plugin route cannot shadow this path (built-ins mount first), so the overlay is
 * the supported way to add `applinks` / extra `webcredentials` apps. Merge rules:
 * `webcredentials.apps` and `appclips.apps` are unioned (order preserved, de-duplicated);
 * every other top-level key is taken from the overlay, and a later overlay wins on conflict.
 */
export const wellKnown = new OpenAPIHono();

export type AasaDocument = Record<string, unknown>;
export type AasaOverlay = () => AasaDocument;

const overlays: AasaOverlay[] = [];

/** Engine shutdown / tests: forget every overlay. */
export function clearAasaOverlays(): void {
  overlays.length = 0;
}

export function registerAasaOverlay(overlay: AasaOverlay): void {
  overlays.push(overlay);
}

const UNION_KEYS = ['webcredentials', 'appclips'] as const;

export function composeAasa(baseIds: readonly string[], list: readonly AasaOverlay[] = overlays): AasaDocument | null {
  const doc: AasaDocument = {};
  if (baseIds.length > 0) doc.webcredentials = { apps: [...baseIds] };
  for (const overlay of list) {
    for (const [key, value] of Object.entries(overlay())) {
      const isUnion = (UNION_KEYS as readonly string[]).includes(key);
      const prev = doc[key] as { apps?: string[] } | undefined;
      const add = (value as { apps?: string[] } | null)?.apps;
      if (isUnion && Array.isArray(add)) {
        doc[key] = { ...(value as object), apps: [...new Set([...(prev?.apps ?? []), ...add])] };
      } else {
        doc[key] = value;
      }
    }
  }
  return Object.keys(doc).length === 0 ? null : doc;
}

wellKnown.get('/.well-known/apple-app-site-association', (c) => {
  const ids = (process.env.AASA_APP_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const doc = composeAasa(ids);
  if (!doc) return c.json({ error: 'not found' }, 404);
  return c.json(doc, 200);
});
