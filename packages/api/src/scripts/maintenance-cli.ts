/**
 * Host-side entrypoint for `sellright maintenance on|off|status` (WS-E). Runs
 * inside the `api` container via `docker compose exec api node
 * dist/scripts/maintenance-cli.js <cmd>` — no Docker socket, no separate
 * privileged process; it just writes/reads the flag file on the volume the
 * api process itself checks (see maintenance.ts).
 */
import { toggleMaintenance } from '../maintenance-toggle.js';
import { isMaintenanceOn, maintenanceInfo } from '../maintenance.js';

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const cmd = argv[0];
  switch (cmd) {
    case 'on':
    case 'off': {
      // ADR-0001 QS-6: flag written, then every host of the store purged. Awaited because this process exits right
      // after; bounded + retried + alert-logged inside runPurge, never throws and never changes the exit code.
      const purge = await toggleMaintenance(cmd === 'on', { reason: cmd === 'on' ? (argv[1] ?? 'update') : undefined });
      console.log(`maintenance: ${cmd}`);
      // Sanity echo so a caller parsing stdout can also just check the exit code.
      process.exitCode = isMaintenanceOn() === (cmd === 'on') ? 0 : 1;
      console.log(`maintenance: edge purge ${purge}`);
      break;
    }
    case 'status':
      console.log(JSON.stringify(maintenanceInfo()));
      break;
    default:
      console.error('usage: maintenance-cli.js <on|off|status> [reason]');
      process.exitCode = 1;
  }
}

void main();
