/**
 * Process-wide description of the running composition, read by the system
 * endpoints (`build-info`, `effective-config`). createApp sets it; routes only read.
 * Absent (null) when the legacy `buildHttpApp()` builder is used without createApp.
 */
import type { EngineContext, EnginePlugin } from './types.js';

export interface EngineState {
  version: string;
  ctx: EngineContext;
  plugins: readonly EnginePlugin[];
  startedAt: Date;
  /** Bound port once listening. */
  port: () => number | null;
  /** Registered job labels while the scheduler runs. */
  jobs: () => { enabled: boolean; names: readonly string[] };
  migrations: () => { engineTable: string; pluginTables: Record<string, string>; mode: 'verify' | 'skip' };
}

let state: EngineState | null = null;

export function setEngineState(next: EngineState | null): void {
  state = next;
}

export function getEngineState(): EngineState | null {
  return state;
}
