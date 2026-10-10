/** `@sellright/api` — the engine SDK entry (plan 2.1). Subpath groups live under `../exports/`. */
export { createApp, EngineSetupError } from './create-app.js';
export type {
  ConfigureContext, CreateAppOptions, EngineApp, EngineContext, EnginePlugin, LifecyclePhase,
  MigrationTableRef, PluginEffectiveConfig, PluginMigrations, ShutdownStep, StartOptions, PluginJob,
} from './types.js';
export { LIFECYCLE_PHASES } from './types.js';
export { routeInventory, type RouteInventory, type InventoryRoute } from './route-inventory.js';
export { fingerprint, type FingerprintHelpers, type SaltedFingerprints } from './fingerprint.js';
export { SELLRIGHT_VERSION } from '../version.js';
export { legacyErrorShape, legacyErrorResponses, legacyExampleViolations, LEGACY_FLAG, type LegacyErrorExample } from './legacy-errors.js';
export { composeAasa, type AasaDocument } from '../routes/well-known.js';
