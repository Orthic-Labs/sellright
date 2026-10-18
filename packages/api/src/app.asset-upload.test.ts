import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import type { AdminPrincipal } from './auth/admin-session.js';
import type { Tx } from './db/client.js';
import { buildHttpApp } from './app.js';
import { withAssetImageSlot } from './lib/asset-image.js';

const state = vi.hoisted(() => ({
  failPersistence: false,
  rows: [] as unknown[],
  principal: {
    id: 'asset-test-admin', email: 'owner@asset-upload.test', kind: 'human', auth: 'session', apiTokenId: null,
    isInstallationAdmin: false, stepUpAt: null,
    stores: [{ storeId: 'asset-test-store', slug: 'asset-test', name: 'Asset test', currency: 'USD', taxRate: 0, shippingTaxable: false, role: 'owner', permissions: null }],
  } as AdminPrincipal,
}));

vi.mock('./auth/admin-session.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./auth/admin-session.js')>(),
  resolveAdmin: async (token: string) => token === 'asset-session' ? state.principal : null,
}));
vi.mock('./db/client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./db/client.js')>(),
  withStore: async <T>(_storeId: string, operation: (tx: Tx) => Promise<T>): Promise<T> => {
    if (state.failPersistence) throw new Error('synthetic asset persistence failure');
    return operation({ insert: () => ({ values: (row: unknown) => {
      state.rows.push(row);
      return { returning: async () => [] };
    } }) } as unknown as Tx);
  },
}));
vi.mock('./cors-origins.js', () => ({ isAllowedCorsOrigin: async () => false, isAllowedAdminCorsOrigin: () => false }));
vi.mock('./maintenance.js', () => ({ isMaintenanceOn: () => false, maintenanceInfo: () => ({ maintenance: false }) }));

const HEADERS = { Authorization: 'Bearer asset-session', 'x-store-slug': 'asset-test' };

beforeEach(() => {
  state.failPersistence = false;
  state.rows = [];
  vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
  vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
  vi.spyOn(fs, 'rm').mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

function unreadBody(bytes = 128) {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    pulls += 1;
    controller.enqueue(new Uint8Array(bytes));
    controller.close();
  } }, { highWaterMark: 0 });
  return { body, pulls: () => pulls };
}

function streamedRequest(body: ReadableStream<Uint8Array>, headers: Record<string, string>) {
  return new Request('http://localhost/v1/admin/assets', {
    method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=synthetic', ...headers }, body, duplex: 'half',
  } as RequestInit);
}

async function imageForm() {
  const bytes = await sharp({ create: { width: 4, height: 3, channels: 3, background: 'white' } }).png().toBuffer();
  const form = new FormData();
  form.set('file', new File([Uint8Array.from(bytes)], 'fixture.png', { type: 'image/png' }));
  form.set('alt', 'Synthetic image');
  return form;
}

describe('asset upload admission before body buffering & multipart validation', () => {
  it.each([{ label: 'unknown length', length: undefined }, { label: 'known length', length: '128' }])('rejects busy $label requests without reading their bodies', async ({ length }) => {
    const app = buildHttpApp();
    const input = unreadBody();
    let release!: () => void;
    const held = withAssetImageSlot(() => new Promise<void>((resolve) => { release = resolve; }));
    try {
      const response = await app.request(streamedRequest(input.body, { ...HEADERS, ...(length ? { 'Content-Length': length } : {}) }));
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('1');
      expect(input.pulls()).toBe(0);
      expect(fs.writeFile).not.toHaveBeenCalled();
    } finally {
      release();
      await held;
    }
  });

  it('authenticates invalid bearer credentials before slot admission or body reads', async () => {
    const app = buildHttpApp();
    const input = unreadBody();
    let release!: () => void;
    const held = withAssetImageSlot(() => new Promise<void>((resolve) => { release = resolve; }));
    try {
      const response = await app.request(streamedRequest(input.body, { Authorization: 'Bearer invalid-session' }));
      expect(response.status).toBe(401);
      expect(input.pulls()).toBe(0);
    } finally {
      release();
      await held;
    }
  });

  it('accepts a real multipart File through the actual OpenAPI validator & writes normalized WebP', async () => {
    const app = buildHttpApp();
    const response = await app.request('/v1/admin/assets', { method: 'POST', headers: HEADERS, body: await imageForm() });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ width: 4, height: 3, alt: 'Synthetic image' });
    expect(fs.writeFile).toHaveBeenCalledOnce();
    const output = vi.mocked(fs.writeFile).mock.calls[0]![1] as Buffer;
    expect(await sharp(output).metadata()).toMatchObject({ format: 'webp', width: 4, height: 3 });
    expect(state.rows).toHaveLength(1);
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it('releases admission after form validation or body-limit rejection', async () => {
    const app = buildHttpApp();
    const form = new FormData();
    form.set('file', 'not a File');
    expect((await app.request('/v1/admin/assets', { method: 'POST', headers: HEADERS, body: form })).status).toBe(400);
    const declared = unreadBody();
    expect((await app.request(streamedRequest(declared.body, { ...HEADERS, 'Content-Length': String(11 * 1024 * 1024) }))).status).toBe(413);
    expect(declared.pulls()).toBe(0);
    const streamed = unreadBody(11 * 1024 * 1024);
    expect((await app.request(streamedRequest(streamed.body, HEADERS))).status).toBe(413);
    expect(streamed.pulls()).toBe(1);
    await expect(withAssetImageSlot(async () => 'released')).resolves.toBe('released');
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('keeps admission occupied through route failure cleanup, then releases it', async () => {
    const app = buildHttpApp();
    state.failPersistence = true;
    let cleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    vi.mocked(fs.rm).mockImplementationOnce(async () => { cleanupStarted(); await cleanup; });
    const pending = Promise.resolve(app.request('/v1/admin/assets', { method: 'POST', headers: HEADERS, body: await imageForm() }));
    expect(await Promise.race([started.then(() => 'cleanup'), pending.then(() => 'response')])).toBe('cleanup');
    try {
      const input = unreadBody();
      expect((await app.request(streamedRequest(input.body, HEADERS))).status).toBe(503);
      expect(input.pulls()).toBe(0);
    } finally {
      releaseCleanup();
      expect((await pending).status).toBe(500);
    }
    await expect(withAssetImageSlot(async () => 'released')).resolves.toBe('released');
    expect(fs.rm).toHaveBeenCalledOnce();
  });
});
