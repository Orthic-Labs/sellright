/**
 * Build identity (plan 2.7 `GET /v1/admin/system/build-info`, plan 2.3 artifact receipt).
 * `BUILD-INFO.json` is written next to the package root by `scripts/write-build-info.mjs`
 * (`pnpm build` / pack) and shipped in the tarball; running from source without one
 * reports `build: null` — never a guessed value.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface BuildInfoFile {
  sha: string;
  dirty: boolean;
  time: string;
  node: string;
}

export interface BuildInfo {
  engine: { name: '@sellright/api'; version: string };
  /** Contents of BUILD-INFO.json, or null when the process runs from a tree without one. */
  build: BuildInfoFile | null;
  node: string;
  /** sha256 of drizzle/meta/_journal.json — identifies the schema the artifact carries. */
  migrationJournalSha256: string | null;
  migrationHead: string | null;
}

/** Package root: this file lives at <root>/src/sdk or <root>/dist/sdk. */
export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function readBuildInfoFile(root: string = PACKAGE_ROOT): BuildInfoFile | null {
  const path = `${root}BUILD-INFO.json`;
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<BuildInfoFile>;
    if (typeof raw.sha !== 'string' || typeof raw.time !== 'string') return null;
    return { sha: raw.sha, dirty: raw.dirty === true, time: raw.time, node: typeof raw.node === 'string' ? raw.node : '' };
  } catch {
    return null;
  }
}

export function readMigrationJournalIdentity(root: string = PACKAGE_ROOT): { sha256: string | null; head: string | null } {
  const path = `${root}drizzle/meta/_journal.json`;
  if (!existsSync(path)) return { sha256: null, head: null };
  const text = readFileSync(path);
  const journal = JSON.parse(text.toString('utf8')) as { entries?: Array<{ tag: string }> };
  const last = journal.entries?.[journal.entries.length - 1];
  return { sha256: createHash('sha256').update(text).digest('hex'), head: last?.tag ?? null };
}

export function collectBuildInfo(version: string, root: string = PACKAGE_ROOT): BuildInfo {
  const journal = readMigrationJournalIdentity(root);
  return {
    engine: { name: '@sellright/api', version },
    build: readBuildInfoFile(root),
    node: process.version,
    migrationJournalSha256: journal.sha256,
    migrationHead: journal.head,
  };
}
