/**
 * Extension seam: configurable request header names for the public
 * apps/licensing routes (routes/apps.ts), sourced from env so a fork can
 * rename them (or add its own header alongside the historical ones) without
 * editing routes/apps.ts.
 *
 * Every default here reproduces the literal header names routes/apps.ts used
 * before this seam existed, so an unconfigured deployment's headers are
 * unchanged.
 */
import { env } from '../env.js';

type ReqCtx = { req: { header: (k: string) => string | undefined } };

function parseHeaderList(raw: string): string[] {
  return raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

/** Header names checked, in order, for an explicit app key (env.APPS_APP_KEY_HEADERS). */
export function appKeyHeaderNames(): string[] {
  return parseHeaderList(env.APPS_APP_KEY_HEADERS);
}

/** Header name carrying the device id on public apps routes (env.APPS_DEVICE_HEADER). */
export function deviceHeaderName(): string {
  return env.APPS_DEVICE_HEADER;
}

/** Header name carrying the legacy bearer-alternative license key (env.APPS_LICENSE_HEADER). */
export function licenseHeaderName(): string {
  return env.APPS_LICENSE_HEADER;
}

/** Returns the first non-empty value of `c.req.header(name)` across `names`, in order. */
export function firstHeader(c: ReqCtx, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = c.req.header(name);
    if (value) return value;
  }
  return undefined;
}
