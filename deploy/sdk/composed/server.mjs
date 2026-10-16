// Composed executable: engine + plugins, runtime role only (DATABASE_URL). Migrations are verified, never applied.
import { createApp } from '@sellright/api';
import { createSamplePlugin } from '@sellright/sample-plugin';

const engine = await createApp({ plugins: [createSamplePlugin()] });
await engine.start({ handleSignals: true });
