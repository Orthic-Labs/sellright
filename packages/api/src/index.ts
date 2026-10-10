import 'dotenv/config';
import { createApp } from './sdk/create-app.js';
import { registerProcessErrorHandlers } from './lib/process-error-handlers.js';

// REL-2: install process-level error handlers BEFORE the server starts so
// nothing in `serve()` / the job scheduler can crash the process without a
// logged, intentional exit.
registerProcessErrorHandlers();

// Thin caller: env parse, pool, privilege check (SR-01), routes, jobs, listener
// and the ordered shutdown all live in the SDK (sdk/create-app.ts). The serving
// process verifies nothing about migrations here (`skip`) — unchanged behaviour;
// the SDK default for composed servers is `verify`.
const engine = await createApp({ migrations: 'skip' });
await engine.start({ handleSignals: true });
