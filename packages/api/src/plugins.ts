/**
 * Extension seam: register extra Hono sub-apps (routes) and boot-time init
 * hooks without editing app.ts.
 *
 * A downstream fork imports `registerApiPlugin` and calls it from its OWN
 * entrypoint (its own `index.ts`, not this package's) BEFORE it calls/imports
 * `createApp()`. `createApp()` mounts every registered plugin's `routes`
 * sub-app at `/` — after all of SellRight's own built-in routes, so a
 * plugin's paths never shadow a built-in one on an exact-path conflict — and
 * then runs each plugin's `init` hook, in registration order, before
 * publishing the OpenAPI doc.
 *
 * Registration is a plain in-memory list: nothing is registered by default,
 * so an unconfigured deployment's `createApp()` output is unchanged.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { ReleaseRegistrationPolicy } from './releases/registration-policy.js';
import type { ErrorResponsePolicy } from './pre-route-policy.js';

export interface ApiPlugin {
  /** Unique plugin name (diagnostics only; also guards against double-registration). */
  name: string;
  /** A Hono/OpenAPIHono sub-app mounted at '/' alongside SellRight's built-in routes. */
  routes?: OpenAPIHono;
  /**
   * Optional synchronous hook run once, after every plugin's `routes` is
   * mounted, before `app.doc()` is published. Receives the constructed app
   * so a plugin can add cross-cutting middleware or `app.onError` overrides
   * of its own.
   */
  init?: (app: OpenAPIHono) => void;
  /**
   * Release registration policy (docs/policies/RELEASE-REGISTRATION.md): claims
   * apps/channels on the engine-hosted `POST /v1/admin/apps/releases`, supplies
   * a tenant-bound service credential and a validation hook. `createApp()`
   * throws at startup if two plugins claim the same app or route.
   */
  releaseRegistration?: ReleaseRegistrationPolicy;
  /**
   * Optional pre-route response policy (see pre-route-policy.ts): a declared
   * route set plus a transformer for JSON error bodies on those routes.
   * Status and headers are preserved; `/v1/admin` is never transformed.
   */
  errorPolicy?: ErrorResponsePolicy;
}

const registered: ApiPlugin[] = [];

/** Register an extension plugin. Call this BEFORE createApp() runs. */
export function registerApiPlugin(plugin: ApiPlugin): void {
  if (registered.some((p) => p.name === plugin.name)) {
    throw new Error(`API plugin "${plugin.name}" is already registered`);
  }
  registered.push(plugin);
}

/** Internal: read by createApp() to mount registered plugins. */
export function listApiPlugins(): readonly ApiPlugin[] {
  return registered;
}

/** Test-only: clear all registered plugins between test runs. */
export function _clearApiPluginsForTest(): void {
  registered.length = 0;
}
