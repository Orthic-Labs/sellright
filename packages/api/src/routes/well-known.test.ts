import { afterEach, describe, expect, it } from 'vitest';
import { clearAasaOverlays, composeAasa, registerAasaOverlay, wellKnown } from './well-known.js';

afterEach(() => { clearAasaOverlays(); delete process.env.AASA_APP_IDS; });

describe('AASA overlay (plan 2.6)', () => {
  it('404s with no ids and no overlay', async () => {
    expect((await wellKnown.request('/.well-known/apple-app-site-association')).status).toBe(404);
  });
  it('serves the env-only document unchanged', async () => {
    process.env.AASA_APP_IDS = 'T1.app.one, T1.app.two';
    const res = await wellKnown.request('/.well-known/apple-app-site-association');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ webcredentials: { apps: ['T1.app.one', 'T1.app.two'] } });
  });
  it('unions webcredentials apps, adds applinks, later overlay wins on other keys', async () => {
    process.env.AASA_APP_IDS = 'T1.app.one';
    registerAasaOverlay(() => ({ webcredentials: { apps: ['T1.app.one', 'T2.app.three'] }, applinks: { details: [{ appID: 'a' }] } }));
    registerAasaOverlay(() => ({ applinks: { details: [{ appID: 'b' }] } }));
    const doc = await (await wellKnown.request('/.well-known/apple-app-site-association')).json();
    expect(doc).toEqual({ webcredentials: { apps: ['T1.app.one', 'T2.app.three'] }, applinks: { details: [{ appID: 'b' }] } });
  });
  it('an overlay alone is enough to serve a document', () => {
    expect(composeAasa([], [() => ({ applinks: { apps: [] } })])).toEqual({ applinks: { apps: [] } });
  });
});
