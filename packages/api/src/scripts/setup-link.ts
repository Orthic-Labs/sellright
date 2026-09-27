import { pool } from '../db/client.js';
import { issueSetupClaimToken, SetupAlreadyClaimedError } from '../auth/setup-claim.js';

/**
 * `sellright setup-link` runs this inside the api container. Contract with
 * deploy/sellright.sh's cmd_setup_link: the raw token, and ONLY the raw
 * token, is written to stdout — every other message goes to stderr — so the
 * shell wrapper can capture it with plain `$(...)` command substitution.
 */
async function main(): Promise<void> {
  const { token, expiresAt } = await issueSetupClaimToken();
  console.error(`[setup-link] token issued, expires ${expiresAt.toISOString()} (single use, invalidates any prior unused token)`);
  console.log(token);
}

main()
  .catch((error) => {
    if (error instanceof SetupAlreadyClaimedError) {
      console.error('[setup-link] this installation is already claimed — use reset-admin instead');
    } else {
      console.error('[setup-link] failed', error);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
