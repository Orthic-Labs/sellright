/**
 * Host-side entrypoint for `sellright maintenance on|off|status` (WS-E). Runs
 * inside the `api` container via `docker compose exec api node
 * dist/scripts/maintenance-cli.js <cmd>` — no Docker socket, no separate
 * privileged process; it just writes/reads the flag file on the volume the
 * api process itself checks (see maintenance.ts).
 */
import { env } from '../env.js';
import { purgeHostForMaintenance } from '../cache/purge-hook.js';
import { isMaintenanceOn, maintenanceInfo, setMaintenance } from '../maintenance.js';

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'on':
      setMaintenance(true, process.argv[3] ?? 'update');
      console.log('maintenance: on');
      break;
    case 'off':
      setMaintenance(false);
      console.log('maintenance: off');
      break;
    case 'status':
      console.log(JSON.stringify(maintenanceInfo()));
      break;
    default:
      console.error('usage: maintenance-cli.js <on|off|status> [reason]');
      process.exitCode = 1;
  }
  // Sanity echo so a caller parsing stdout can also just check the exit code.
  if (cmd === 'on' || cmd === 'off') {
    process.exitCode = isMaintenanceOn() === (cmd === 'on') ? 0 : 1;
    // ADR-0001 QS-6: the flag file is written, so purge every cached page for the host. Awaited because this process
    // exits right after; bounded + retried + alert-logged inside runPurge, never throws and never changes the exit code.
    if (env.STORE_SLUG) console.log(`maintenance: edge purge ${await purgeHostForMaintenance(env.STORE_SLUG)}`);
  }
}

void main();
