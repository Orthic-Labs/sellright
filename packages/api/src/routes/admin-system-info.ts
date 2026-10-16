/**
 * Read-only system endpoints (plan 2.7). Install-wide data (secret fingerprints, database
 * identity, paths, job state), so they require installation-admin authority in addition to
 * the per-store `owner` role: owning one store of a multi-store install must never expose it (review F1). never mutate, never return a
 * secret (effective-config carries fingerprints only — see sdk/fingerprint.ts).
 *
 *   GET /v1/admin/system/build-info
 *   GET /v1/admin/system/effective-config   (versioned projection `config/v1`)
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { getEnv, getEnvSource } from '../env.js';
import { collectBuildInfo } from '../sdk/build-info.js';
import { getEngineState } from '../sdk/engine-state.js';
import { projectEffectiveConfig, CONFIG_SCHEMA_VERSION } from '../sdk/effective-config.js';
import { J, errBody, guard, requireAdmin, requireInstallationAdmin, requireOwner, requireStore } from './admin-helpers.js';
import { SELLRIGHT_VERSION } from '../version.js';

export const adminSystemInfo = new OpenAPIHono();

const BuildInfoSchema = z.object({
  engine: z.object({ name: z.literal('@sellright/api'), version: z.string() }),
  build: z.object({ sha: z.string(), dirty: z.boolean(), time: z.string(), node: z.string() }).nullable(),
  node: z.string(),
  migrationJournalSha256: z.string().nullable(),
  migrationHead: z.string().nullable(),
  plugins: z.array(z.string()),
});

adminSystemInfo.openapi(
  createRoute({
    method: 'get',
    path: '/v1/admin/system/build-info',
    summary: 'Build identity of the running artifact (installation administrator + store owner)',
    responses: {
      200: { description: 'OK', content: J(BuildInfoSchema) },
      401: { description: 'Unauthorized', ...errBody },
      403: { description: 'Forbidden', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    requireInstallationAdmin(admin);
    requireOwner(requireStore(admin, c));
    const state = getEngineState();
    return c.json({
      ...collectBuildInfo(state?.version ?? SELLRIGHT_VERSION),
      plugins: (state?.plugins ?? []).map((p) => p.name),
    }, 200);
  }),
);

const EffectiveConfigSchema = z.object({
  schema: z.literal(CONFIG_SCHEMA_VERSION),
  store: z.object({ slug: z.string() }),
  intended: z.record(z.string(), z.unknown()),
  deployment: z.record(z.string(), z.unknown()),
});

adminSystemInfo.openapi(
  createRoute({
    method: 'get',
    path: '/v1/admin/system/effective-config',
    summary: 'Effective configuration projection config/v1 — secrets as fingerprints only (installation administrator + store owner)',
    responses: {
      200: { description: 'OK', content: J(EffectiveConfigSchema) },
      401: { description: 'Unauthorized', ...errBody },
      403: { description: 'Forbidden', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    requireInstallationAdmin(admin);
    const st = requireStore(admin, c);
    requireOwner(st);
    const projection = await projectEffectiveConfig({ env: getEnv(), source: getEnvSource(), store: st });
    return c.json(projection, 200);
  }),
);
