import { afterEach, describe, expect, it } from 'vitest';

const ORIGINAL = process.env.AASA_APP_IDS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.AASA_APP_IDS;
  else process.env.AASA_APP_IDS = ORIGINAL;
});

describe('GET /.well-known/apple-app-site-association', () => {
  it('404s when AASA_APP_IDS is unset (no mobile app deployed)', async () => {
    delete process.env.AASA_APP_IDS;
    const { wellKnown } = await import('./well-known.js');
    const res = await wellKnown.request('/.well-known/apple-app-site-association');
    expect(res.status).toBe(404);
  });

  it('404s when AASA_APP_IDS is set to an empty/whitespace-only value', async () => {
    process.env.AASA_APP_IDS = '  , ,';
    const { wellKnown } = await import('./well-known.js');
    const res = await wellKnown.request('/.well-known/apple-app-site-association');
    expect(res.status).toBe(404);
  });

  it('returns the webcredentials app id list as JSON when configured', async () => {
    process.env.AASA_APP_IDS = 'ABCDE12345.com.example.app, ABCDE12345.com.example.app.dev';
    const { wellKnown } = await import('./well-known.js');
    const res = await wellKnown.request('/.well-known/apple-app-site-association');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({
      webcredentials: { apps: ['ABCDE12345.com.example.app', 'ABCDE12345.com.example.app.dev'] },
    });
  });
});
