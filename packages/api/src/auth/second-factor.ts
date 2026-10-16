/**
 * Admin second factor (P1b, security audit 2026-10-15): TOTP code OR a one-time recovery code.
 *
 * Recovery codes: 10 per enrolment, 16 base32 characters (80 random bits) shown once as
 * `xxxx-xxxx-xxxx-xxxx`; only sha256 of the normalized code is stored (admin_recovery_code). With 80 bits
 * an offline guess against the hash is infeasible, so a slow KDF is unnecessary. Consumption is a single
 * `UPDATE ... WHERE used_at IS NULL RETURNING` — a code can never be redeemed twice, even concurrently.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, count, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { unsafeUnscopedDb as db } from '../db/client.js';
import * as s from '../db/schema.js';
import { matchTotpStep } from './totp.js';

export const RECOVERY_CODE_COUNT = 10;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z2-7]/g, '');
const hashRecoveryCode = (code: string) => createHash('sha256').update(`sellright-recovery:${normalizeRecoveryCode(code)}`).digest('hex');

function newRecoveryCode(): string {
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += B32[bytes[i]! & 31];
  return out.match(/.{4}/g)!.join('-');
}

type Db = Pick<typeof db, 'insert' | 'delete'>;

/** Replace this admin's recovery codes with a fresh set; returns the plaintext codes (show once). One transaction,
 *  serialized per admin: concurrent regenerations cannot leave two valid sets, and a failure keeps the old set. */
export async function regenerateRecoveryCodes(adminId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'recovery-codes:' + adminId}, 0))`);
    await tx.delete(s.adminRecoveryCode).where(eq(s.adminRecoveryCode.adminUserId, adminId));
    await tx.insert(s.adminRecoveryCode).values(codes.map((c) => ({ adminUserId: adminId, codeHash: hashRecoveryCode(c) })));
  });
  return codes;
}

export async function deleteRecoveryCodes(adminId: string, tx: Db = db): Promise<void> {
  await tx.delete(s.adminRecoveryCode).where(eq(s.adminRecoveryCode.adminUserId, adminId));
}

export async function remainingRecoveryCodes(adminId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(s.adminRecoveryCode)
    .where(and(eq(s.adminRecoveryCode.adminUserId, adminId), isNull(s.adminRecoveryCode.usedAt)));
  return Number(r?.n ?? 0);
}

async function consumeRecoveryCode(adminId: string, code: string): Promise<boolean> {
  if (normalizeRecoveryCode(code).length !== 16) return false;
  const used = await db
    .update(s.adminRecoveryCode)
    .set({ usedAt: new Date() })
    .where(and(eq(s.adminRecoveryCode.adminUserId, adminId), eq(s.adminRecoveryCode.codeHash, hashRecoveryCode(code)), isNull(s.adminRecoveryCode.usedAt)))
    .returning({ id: s.adminRecoveryCode.id });
  return used.length === 1;
}

/**
 * TOTP with a DURABLE, atomic replay guard (security audit 2026-10-15): every accepted time-step is recorded in
 * admin_totp_used_step. Under a per-admin transaction advisory lock, a code is accepted only if no step >= its
 * own has been accepted before for this admin (RFC 6238 §5.2: never accept a step at or before the last one
 * used), then its step is recorded. Holds across API processes and restarts — the old guard remembered only the
 * last step per admin in process memory. Rows older than the ±1-step window are pruned on the way.
 */
export async function verifyTotpOnce(adminId: string, secretB32: string, code: string): Promise<boolean> {
  const step = matchTotpStep(secretB32, code);
  if (step === null) return false;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'totp-step:' + adminId}, 0))`);
    await tx.delete(s.adminTotpUsedStep).where(and(eq(s.adminTotpUsedStep.adminUserId, adminId), lt(s.adminTotpUsedStep.step, step - 10)));
    const [later] = await tx.select({ step: s.adminTotpUsedStep.step }).from(s.adminTotpUsedStep)
      .where(and(eq(s.adminTotpUsedStep.adminUserId, adminId), gte(s.adminTotpUsedStep.step, step))).limit(1);
    if (later) return false; // replay (same step) or an older code after a newer one was used
    await tx.insert(s.adminTotpUsedStep).values({ adminUserId: adminId, step });
    return true;
  });
}

/** Verify the second factor for an admin whose (plaintext) TOTP secret is `secretB32`: a 6-digit TOTP
 *  code (replay-guarded per admin) or an unused recovery code (consumed on success). */
export async function verifySecondFactor(adminId: string, secretB32: string, code: string | undefined): Promise<boolean> {
  if (!code) return false;
  const c = code.trim();
  if (/^\d{6}$/.test(c)) return verifyTotpOnce(adminId, secretB32, c);
  return consumeRecoveryCode(adminId, c);
}
