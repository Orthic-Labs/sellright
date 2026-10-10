/**
 * DB test: a magic-link request's email row is delivered by the post-commit
 * wake within ~1 s, with no 60 s scheduler pass running. Uses the SMTP mailer
 * mock (same pattern as outbox.test.ts). Real timers on purpose: the assertion
 * is a wall-clock bound, not a fake-timer advance.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';

vi.mock('./mailer.js', () => ({
  sendEmail: vi.fn(),
}));

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`wake db test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

import { sendEmail } from './mailer.js';
import { enqueueMagicLink, type StoreEmailCtx } from './dispatch.js';
import { setEmailWakeEnabledForTests } from './wake.js';

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const CTX: StoreEmailCtx = {
  name: 'Wake Test Store',
  currency: 'USD',
  config: { storefrontUrl: 'https://wake-test.example', emailFrom: 'orders@wake-test.example' },
  storeId: STORE,
};
const DEADLINE_MS = 1_500;

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seedStore(): Promise<void> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES ($1, 'wake-test', 'Wake Test Store', 'USD', $2::jsonb) ON CONFLICT (id) DO NOTHING`,
    [STORE, JSON.stringify(CTX.config)],
  );
}

async function statusesFor(recipient: string): Promise<string[]> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT status FROM email_outbox WHERE store_id = ${STORE} AND recipient = ${recipient}`);
    return (r.rows as Array<{ status: string }>).map((x) => x.status);
  });
}

async function waitForStatus(recipient: string, want: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const s = await statusesFor(recipient);
    if (s.length && s.every((x) => x === want)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe('post-commit email wake (magic link)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await wipe();
    await seedStore();
    setEmailWakeEnabledForTests(() => true);
  });
  afterAll(async () => {
    setEmailWakeEnabledForTests(null);
    await wipe();
    await pool.end();
  });

  it('magic-link request is sent within ~1 s of commit (no 60 s poll running)', async () => {
    vi.mocked(sendEmail).mockResolvedValue({ delivered: true });
    const to = 'wake-magic@example.com';

    await withStore(STORE, (tx) =>
      enqueueMagicLink(tx, STORE, CTX, to, { url: 'https://wake-test.example/magic?t=abc', ttlMinutes: 15 }),
    );
    const committedAt = Date.now();

    const sent = await waitForStatus(to, 'sent', DEADLINE_MS);
    expect(sent).toBe(true);
    expect(Date.now() - committedAt).toBeLessThan(DEADLINE_MS);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a rolled-back request never wakes or sends', async () => {
    vi.mocked(sendEmail).mockResolvedValue({ delivered: true });
    const to = 'wake-rollback@example.com';

    await expect(
      withStore(STORE, async (tx) => {
        await enqueueMagicLink(tx, STORE, CTX, to, { url: 'https://wake-test.example/magic?t=rb', ttlMinutes: 15 });
        throw new Error('request failed after enqueue');
      }),
    ).rejects.toThrow('request failed after enqueue');

    await new Promise((r) => setTimeout(r, DEADLINE_MS));
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await statusesFor(to)).toEqual([]);
  });

  it('with JOBS_ENABLED off the row stays pending (the 60 s poll is the fallback)', async () => {
    setEmailWakeEnabledForTests(() => false);
    const to = 'wake-off@example.com';

    await withStore(STORE, (tx) =>
      enqueueMagicLink(tx, STORE, CTX, to, { url: 'https://wake-test.example/magic?t=off', ttlMinutes: 15 }),
    );
    await new Promise((r) => setTimeout(r, DEADLINE_MS));
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await statusesFor(to)).toEqual(['pending']);
  });
});
