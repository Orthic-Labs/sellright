import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  serve: vi.fn(),
  jobs: vi.fn(),
  stopJobs: vi.fn(async () => {}),
  startInvalidation: vi.fn(async () => {}),
  stopInvalidation: vi.fn(async () => {}),
  closePools: vi.fn(async () => {}),
  closeResources: vi.fn(async () => []),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@hono/node-server', () => ({ serve: mocks.serve }));
vi.mock('../app.js', () => ({ buildHttpApp: () => ({ fetch: vi.fn() }) }));
vi.mock('../env.js', () => ({
  initEnv: () => ({ NODE_ENV: 'test', PORT: 3300, HOST: '127.0.0.1' }),
  envOrigin: () => undefined,
  extendEnv: vi.fn(),
  closeEnv: vi.fn(),
}));
vi.mock('../db/client.js', () => ({
  initPools: () => ({}),
  poolsInitialised: () => false,
  assertRuntimeRoleUnprivileged: vi.fn(async () => {}),
  checkConnectionBudget: vi.fn(async () => {}),
  checkSchedulerLeaseAccess: vi.fn(async () => {}),
  closePools: mocks.closePools,
}));
vi.mock('../db/schema.js', () => ({}));
vi.mock('../resources.js', () => ({ closeEngineResources: mocks.closeResources, markEngineClosed: vi.fn() }));
vi.mock('../jobs/scheduler.js', () => ({ startJobScheduler: mocks.jobs }));
vi.mock('../store-context.js', () => ({
  startStoreCacheInvalidationListener: mocks.startInvalidation,
  stopStoreCacheInvalidationListener: mocks.stopInvalidation,
}));
vi.mock('../lib/logger.js', () => ({ log: { info: mocks.info, warn: vi.fn() }, err: { error: mocks.error }, resetLogger: vi.fn() }));
vi.mock('./fingerprint.js', () => ({ fingerprint: {} }));
vi.mock('../routes/well-known.js', () => ({ clearAasaOverlays: vi.fn(), registerAasaOverlay: vi.fn() }));
vi.mock('./engine-state.js', () => ({ setEngineState: vi.fn() }));
vi.mock('../auth/totp-secret.js', () => ({ sealLegacyTotpSecrets: vi.fn(async () => 0) }));
vi.mock('./migrations.js', () => ({
  assertMigrationsCurrent: vi.fn(async () => {}),
  resolveTracks: () => [{ name: 'engine', schema: 'drizzle', table: '__drizzle_migrations' }],
}));

import { createApp } from './create-app.js';
import type { EngineApp } from './types.js';

/** The test controls listening/error events; no socket or database is opened. */
class MockServer extends EventEmitter {
  listening = false;
  readonly close = vi.fn((callback?: (error?: Error) => void) => {
    const wasListening = this.listening;
    this.listening = false;
    callback?.(wasListening ? undefined : Object.assign(new Error('not listening'), { code: 'ERR_SERVER_NOT_RUNNING' }));
    return this;
  });
  readonly closeIdleConnections = vi.fn();
  readonly closeAllConnections = vi.fn();

  constructor(private readonly onListen: (info: AddressInfo) => void) { super(); }
  address() { return this.listening ? { address: '127.0.0.1', family: 'IPv4', port: 1234 } : null; }
  finishListening() {
    this.listening = true;
    this.onListen(this.address()!);
  }
}

let engine: EngineApp | undefined;
let servers: MockServer[];
beforeEach(() => {
  vi.clearAllMocks();
  servers = [];
  mocks.serve.mockImplementation((_options: unknown, onListen: (info: AddressInfo) => void) => {
    const server = new MockServer(onListen);
    servers.push(server);
    return server;
  });
  mocks.jobs.mockReturnValue({ enabled: false, jobs: [], stop: mocks.stopJobs });
});
afterEach(async () => {
  await engine?.shutdown();
  engine = undefined;
});

describe('SDK start admission', () => {
  it('rejects an overlapping start before creating a second listener', async () => {
    engine = await createApp();
    const first = engine.start();
    await expect(engine.start()).rejects.toMatchObject({ code: 'ENGINE_PHASE' });
    expect(mocks.serve).toHaveBeenCalledTimes(1);
    expect(mocks.jobs).not.toHaveBeenCalled();

    servers[0]!.finishListening();
    await first;
    expect(engine.phase).toBe('started');
    expect(mocks.jobs).toHaveBeenCalledTimes(1);
    await expect(engine.start()).rejects.toMatchObject({ code: 'ENGINE_PHASE' });
    await engine.shutdown();
    expect(servers[0]!.close).toHaveBeenCalledTimes(1);
    expect(servers.every((server) => !server.listening)).toBe(true);
  });

  it('closes a failed listening attempt before allowing a retry', async () => {
    engine = await createApp();
    const failure = new Error('listen failed');
    const first = engine.start();
    const rejected = expect(first).rejects.toBe(failure);
    servers[0]!.emit('error', failure);
    await rejected;
    expect(servers[0]!.close).toHaveBeenCalledTimes(1);
    expect(engine.phase).toBe('created');

    const retry = engine.start();
    servers[1]!.finishListening();
    await retry;
    // An obsolete callback must close only its own server, not discard the retry.
    servers[0]!.finishListening();
    expect(servers[0]!.listening).toBe(false);
    expect(engine.port).toBe(1234);
    await engine.shutdown();
    expect(servers[1]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.jobs).toHaveBeenCalledTimes(1);
  });

  it('closes a listener when a plugin jobs hook rejects startup', async () => {
    const failure = new Error('jobs failed');
    engine = await createApp({ plugins: [{ name: 'broken', jobs: () => { throw failure; } }] });
    const start = engine.start();
    const rejected = expect(start).rejects.toBe(failure);
    servers[0]!.finishListening();
    await rejected;
    expect(servers[0]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.jobs).not.toHaveBeenCalled();
    expect(engine.port).toBeNull();
  });

  it('retains failed listener ownership if cleanup fails', async () => {
    engine = await createApp();
    const failure = new Error('listen failed');
    const cleanupFailure = new Error('close failed');
    const start = engine.start();
    const rejected = expect(start).rejects.toBe(failure);
    const server = servers[0]!;
    server.close.mockImplementationOnce((callback) => {
      callback?.(cleanupFailure);
      return server;
    });
    server.emit('error', failure);
    await rejected;
    await expect(engine.start()).rejects.toMatchObject({ code: 'ENGINE_PHASE' });
    expect(mocks.serve).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith('failed startup listener could not close', cleanupFailure);
    await engine.shutdown();
    expect(server.close).toHaveBeenCalledTimes(2);
  });

  it('settles shutdown before a pending listen and closes a late listening callback', async () => {
    engine = await createApp();
    const sigtermHandlers = process.listenerCount('SIGTERM');
    const sigintHandlers = process.listenerCount('SIGINT');
    const start = engine.start({ handleSignals: true });
    const rejected = expect(start).rejects.toMatchObject({ code: 'ENGINE_PHASE' });
    const shutdown = engine.shutdown({ timeoutMs: 25 });
    expect(engine.phase).toBe('stopping');
    expect(mocks.stopInvalidation).toHaveBeenCalledTimes(1);
    await rejected;
    await shutdown;
    expect(engine.phase).toBe('closed');
    expect(mocks.closePools).toHaveBeenCalledTimes(1);
    expect(servers[0]!.close).toHaveBeenCalledTimes(1);

    servers[0]!.finishListening();
    expect(servers[0]!.close).toHaveBeenCalledTimes(2);
    expect(servers[0]!.listening).toBe(false);
    expect(engine.phase).toBe('closed');
    expect(engine.port).toBeNull();
    expect(mocks.jobs).not.toHaveBeenCalled();
    expect(mocks.startInvalidation).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGTERM')).toBe(sigtermHandlers);
    expect(process.listenerCount('SIGINT')).toBe(sigintHandlers);
    await expect(engine.start()).rejects.toMatchObject({ code: 'ENGINE_PHASE' });
  });
});
