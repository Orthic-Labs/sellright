import { describe, expect, it, vi } from 'vitest';
import { applyLegacyLink } from './listmonk-legacy-links.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const cfg = { url: 'https://listmonk.example.com/', apiUser: 'u', apiToken: 'secret-t', listId: 7 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sub = (membership: 'confirmed' | 'unconfirmed' | 'unsubscribed' | null, extra: Record<string, unknown> = {}) => ({
  data: { results: [{ id: 42, uuid: UUID, email: 'jo@x.test', status: 'enabled', lists: membership ? [{ id: 7, subscription_status: membership }] : [{ id: 9, subscription_status: 'confirmed' }], ...extra }] },
});
const mk = (lookup: unknown) => vi.fn(async (_u: string, init?: RequestInit) => (init?.method === 'PUT' ? json(200, { data: true }) : json(200, lookup)));
const run = (action: 'confirm' | 'unsubscribe', f: ReturnType<typeof mk>, id = UUID) => applyLegacyLink(cfg, action, id, f as never);
const puts = (f: ReturnType<typeof mk>) => f.mock.calls.filter((c) => c[1]?.method === 'PUT');

describe('applyLegacyLink', () => {
  it('confirm: adds the subscriber to this store list only, as confirmed', async () => {
    const f = mk(sub('unconfirmed'));
    expect(await run('confirm', f)).toEqual({ ok: true, result: 'confirmed', email: 'jo@x.test' });
    expect(f.mock.calls[0]![0]).toContain('https://listmonk.example.com/api/subscribers?query=');
    expect(JSON.parse(String(puts(f)[0]![1]!.body))).toEqual({ ids: [42], target_list_ids: [7], action: 'add', status: 'confirmed' });
    expect((puts(f)[0]![1]!.headers as Record<string, string>).authorization).toBe('Basic ' + Buffer.from('u:secret-t').toString('base64'));
  });

  it('confirm: already confirmed is a no-write success; unsubscribed is never revived', async () => {
    const done = mk(sub('confirmed'));
    expect(await run('confirm', done)).toMatchObject({ ok: true, result: 'already_confirmed' });
    expect(puts(done)).toHaveLength(0);
    const out = mk(sub('unsubscribed'));
    expect(await run('confirm', out)).toMatchObject({ ok: true, result: 'already_unsubscribed' });
    expect(puts(out)).toHaveLength(0);
  });

  it('unsubscribe: only this list, idempotent', async () => {
    const f = mk(sub('confirmed'));
    expect(await run('unsubscribe', f)).toMatchObject({ ok: true, result: 'unsubscribed' });
    expect(JSON.parse(String(puts(f)[0]![1]!.body))).toEqual({ ids: [42], target_list_ids: [7], action: 'unsubscribe' });
    for (const m of ['unsubscribed', null] as const) {
      const again = mk(sub(m));
      expect(await run('unsubscribe', again)).toMatchObject({ ok: true, result: 'already_unsubscribed' });
      expect(puts(again)).toHaveLength(0);
    }
  });

  it('malformed uuid, unknown subscriber, wrong uuid back, blocklisted, bad listId: not_found, nothing written', async () => {
    const none = mk({ data: { results: [] } });
    expect(await run('confirm', none, 'not-a-uuid')).toEqual({ ok: false, reason: 'not_found' });
    expect(none).not.toHaveBeenCalled();
    expect(await run('confirm', none)).toEqual({ ok: false, reason: 'not_found' });
    expect(await run('confirm', mk(sub('unconfirmed', { uuid: '00000000-0000-4000-8000-000000000000' })))).toEqual({ ok: false, reason: 'not_found' });
    const block = mk(sub('unconfirmed', { status: 'blocklisted' }));
    expect(await run('confirm', block)).toEqual({ ok: false, reason: 'not_found' });
    expect(puts(block)).toHaveLength(0);
    const f = mk(sub('unconfirmed'));
    expect(await applyLegacyLink({ ...cfg, listId: undefined }, 'confirm', UUID, f as never)).toEqual({ ok: false, reason: 'not_found' });
    expect(f).not.toHaveBeenCalled();
  });

  it('Listmonk failures throw (the route answers 502) without leaking the token', async () => {
    const lookupFails = vi.fn(async () => json(500, {}));
    await expect(applyLegacyLink(cfg, 'unsubscribe', UUID, lookupFails as never)).rejects.toThrow('subscriber lookup HTTP 500');
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const err = await applyLegacyLink(cfg, 'unsubscribe', UUID, down as never).catch((e: unknown) => e);
    expect(String(err)).toContain('ECONNREFUSED');
    expect(String(err)).not.toContain('secret-t');
    const putFails = vi.fn(async (_u: string, init?: RequestInit) => (init?.method === 'PUT' ? json(500, {}) : json(200, sub('confirmed'))));
    await expect(run('unsubscribe', putFails as never)).rejects.toThrow('list update HTTP 500');
  });
});
