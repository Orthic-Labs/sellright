/** The unified migration preflight rolls back by default and writes a private manifest. */
import { migrationCli } from './run.js';
await migrationCli();
