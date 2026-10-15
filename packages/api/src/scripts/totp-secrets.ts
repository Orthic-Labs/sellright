import { pool } from '../db/client.js';
import { sealLegacyTotpSecrets, unsealAllTotpSecrets } from '../auth/totp-secret.js';

/**
 * Admin TOTP secrets at rest (0097 / P1b).
 *   node dist/scripts/totp-secrets.js            seal every legacy plaintext secret (the API also does this at start)
 *   node dist/scripts/totp-secrets.js --decrypt  ROLLBACK ONLY: rewrite sealed secrets as plaintext, so an engine
 *                                                older than 0097 (which reads totp_secret as plaintext) still verifies 2FA
 * Both need SELLRIGHT_MASTER_KEY. Prints only counts, never a secret.
 */
async function main(): Promise<void> {
  if (process.argv.includes('--decrypt')) {
    console.log(`[totp-secrets] unsealed ${await unsealAllTotpSecrets()} admin TOTP secret(s)`);
  } else {
    if (!process.env.SELLRIGHT_MASTER_KEY?.trim()) throw new Error('SELLRIGHT_MASTER_KEY is not set — nothing to seal with');
    console.log(`[totp-secrets] sealed ${await sealLegacyTotpSecrets()} admin TOTP secret(s)`);
  }
}

main()
  .catch((error) => { console.error('[totp-secrets] failed', error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(async () => { await pool.end().catch(() => undefined); });
