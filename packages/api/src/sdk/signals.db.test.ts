/**
 * REL-1 graceful shutdown, now owned by the SDK (`start({ handleSignals: true })`);
 * replaces the old index.ts-level shutdown.test.ts. Real createApp + real Postgres.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { _resetEnvForTest } from '../env.js';
import { _resetPoolsForTest, poolsInitialised } from '../db/client.js';
import { createApp } from './create-app.js';
import { isEngineClosed } from '../resources.js';
import type { EngineApp } from './types.js';

assertTestDatabase(process.env.DATABASE_URL ?? '', 'signals.db.test.ts');
const env = () => ({ ...process.env, NODE_ENV: 'test' });
let engine: EngineApp | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  await engine?.shutdown().catch(() => undefined);
  engine = undefined;
  _resetEnvForTest();
  _resetPoolsForTest();
});

const exited = (spy: ReturnType<typeof vi.spyOn>) => new Promise<number>((resolve) => {
  const t = setInterval(() => { if (spy.mock.calls.length) { clearInterval(t); resolve(spy.mock.calls[0]![0] as number); } }, 10);
});

describe.each(['SIGTERM', 'SIGINT'] as const)('%s', (sig) => {
  it('drains HTTP, closes the pool, then exits 0', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    engine = await createApp({ env: env() });
    await engine.start({ listen: { port: 0, hostname: '127.0.0.1' }, handleSignals: true });
    process.emit(sig);
    expect(await exited(exit)).toBe(0);
    expect(engine.shutdownSteps.map((s) => s.step)).toEqual(['stop-admitting', 'cancel-jobs', 'drain-http', 'plugin-shutdown', 'close-resources', 'close-pool']);
    expect(poolsInitialised()).toBe(false);
    expect(process.listenerCount(sig)).toBe(0);
  });
});

describe('edge cases', () => {
  it('a straggler reading env after shutdown gets the value, not a throw (review F4)', async () => {
    const { env: liveEnv } = await import('../env.js');
    engine = await createApp({ env: env() });
    await engine.shutdown();
    expect(liveEnv.NODE_ENV).toBe('test');
    expect(isEngineClosed()).toBe(true);
  });

  it('a second SIGTERM during shutdown is ignored (single exit)', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    engine = await createApp({ env: env(), plugins: [{ name: 'slow', shutdown: () => new Promise((r) => setTimeout(r, 200)) }] });
    await engine.start({ listen: { port: 0, hostname: '127.0.0.1' }, handleSignals: true });
    process.emit('SIGTERM');
    process.emit('SIGTERM');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('during shutdown'));
    expect(await exited(exit)).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('forces exit(1) when shutdown hangs past the timeout', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let release: () => void = () => undefined;
    engine = await createApp({ env: env(), plugins: [{ name: 'hang', shutdown: () => new Promise<void>((r) => { release = r; }) }] });
    await engine.start({ listen: { port: 0, hostname: '127.0.0.1' }, handleSignals: true, shutdownTimeoutMs: 150 });
    process.emit('SIGTERM');
    expect(await exited(exit)).toBe(1);
    release(); // let the test's own teardown finish
  });
});
