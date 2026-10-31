/**
 * ADR-0001: server-only per-request flag "this render is a shell render" (set by entry.express.tsx from the request middleware's
 * mark), so `shellRender()` redacts values only for a request that may be stored as a shared shell. A dynamic or excluded route
 * (SHELL_CACHE_EXCLUDE) renders exactly as with the switch off. Same `.server.ts` convention as sellright-request-host.server.ts.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const shellRenderContext = new AsyncLocalStorage<boolean>();
