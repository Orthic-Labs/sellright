// The SheerID settings form: secrets are write-only (never rendered from the
// API, only sent when typed) and the patch clears empty text fields.
import { describe, expect, it } from 'vitest';
import { buildSheerIdPatch } from './SheerIdSettings';

const base = { programId: ' prog-1 ', theme: '', ttlDays: '30', clientId: '', clientSecret: '', webhookSecret: '' };

describe('buildSheerIdPatch', () => {
  it('omits blank secrets so stored values are kept, and nulls cleared text fields', () => {
    const patch = buildSheerIdPatch(base);
    expect(patch).toEqual({ programId: 'prog-1', theme: null, verificationTtlDays: 30 });
    expect(Object.keys(patch)).not.toContain('clientSecret');
    expect(Object.keys(patch)).not.toContain('webhookSecret');
  });

  it('sends only the secrets that were typed', () => {
    expect(buildSheerIdPatch({ ...base, clientId: 'cid', clientSecret: 'sec', webhookSecret: '' }))
      .toMatchObject({ clientId: 'cid', clientSecret: 'sec' });
    expect(buildSheerIdPatch({ ...base, webhookSecret: 'wh' })).toMatchObject({ webhookSecret: 'wh' });
  });

  it('drops an out-of-range ttl instead of sending it', () => {
    expect(buildSheerIdPatch({ ...base, ttlDays: '0' })).not.toHaveProperty('verificationTtlDays');
    expect(buildSheerIdPatch({ ...base, ttlDays: 'abc' })).not.toHaveProperty('verificationTtlDays');
  });
});
