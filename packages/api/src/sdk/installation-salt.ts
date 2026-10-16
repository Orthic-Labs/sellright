/**
 * Per-installation fingerprint salt (plan 2.7, review F3). 32 random bytes (hex, 64 chars),
 * created on first use and stored in `installation_setting`; never derived from a secret and
 * never exposed. Concurrent creators converge on one value (INSERT ... ON CONFLICT DO NOTHING,
 * then re-read).
 */
import { randomBytes } from 'node:crypto';
import { pool } from '../db/client.js';

export const FINGERPRINT_SALT_KEY = 'config_fingerprint_salt';

export async function installationFingerprintSalt(): Promise<string> {
  const read = async () => (await pool.query<{ value: string }>('SELECT value FROM installation_setting WHERE key = $1', [FINGERPRINT_SALT_KEY])).rows[0]?.value;
  const existing = await read();
  if (existing) return existing;
  await pool.query(
    'INSERT INTO installation_setting (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
    [FINGERPRINT_SALT_KEY, randomBytes(32).toString('hex')],
  );
  const value = await read();
  if (!value) throw new Error('could not read or create the installation fingerprint salt');
  return value;
}
