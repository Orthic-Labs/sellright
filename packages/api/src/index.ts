import 'dotenv/config';
import { createApp } from './sdk/create-app.js';
import { warnIfTurnstileDisabled } from './security/turnstile.js';
import { registerProcessErrorHandlers } from './lib/process-error-handlers.js';
import { migrationModeFromEnv, SKIP_MIGRATION_VERIFY_ENV } from './migration-gate.js';

// REL-2: install process-level error handlers BEFORE the server starts so
// nothing in `serve()` / the job scheduler can crash the process without a
// logged, intentional exit.
registerProcessErrorHandlers();

// Thin caller: env parse, pool, privilege check (SR-01), routes, jobs, listener
// and the ordered shutdown all live in the SDK (sdk/create-app.ts). The serving
// process VERIFIES migrations and refuses to start while any are pending
// (PendingMigrationsError), so new code never serves against an old schema. The
// journal is read through the least-privilege probe from migration 0095. The only
// way to skip is the explicit migration-runner override (migration-gate.ts).
warnIfTurnstileDisabled();
const migrations = migrationModeFromEnv(process.env);
if (migrations === 'skip') console.warn(`[sellright] ${SKIP_MIGRATION_VERIFY_ENV} is set: migration verification is OFF for this process (migration runner only).`);
const engine = await createApp({ migrations });
await engine.start({ handleSignals: true });
