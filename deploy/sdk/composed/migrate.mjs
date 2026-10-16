// Release step: applies the engine track, then each plugin track, with the OWNER credential.
import { runMigrations } from '@sellright/api/ops';
import { createSamplePlugin } from '@sellright/sample-plugin';

const databaseUrl = process.env.MIGRATE_DATABASE_URL;
if (!databaseUrl) throw new Error('MIGRATE_DATABASE_URL (owner credential) is required');
const applied = await runMigrations({ databaseUrl, plugins: [createSamplePlugin()] });
console.log(`[migrate] ${applied.map((s) => s.track.name).join(', ')} up to date`);
