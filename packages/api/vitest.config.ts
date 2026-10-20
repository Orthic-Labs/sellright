import { defineConfig } from 'vitest/config';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** Recursively collect `src/**\/*.test.ts` as root-relative posix paths. */
function collectTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTestFiles(abs));
    else if (entry.name.endsWith('.test.ts')) out.push(relative(ROOT, abs).split(sep).join('/'));
  }
  return out.sort();
}

/**
 * DB-gated lanes are derived from a self-declared sentinel, not a hand-
 * maintained file list (SR-11 — the old `test`/`test:db` pair drifted:
 * payments/subscriptions.test.ts and payments/webhook-reconcile.test.ts were
 * DB-gated but appeared in NEITHER list, so their cases never ran).
 *
 * A test file is DB-COUPLED when it says so itself:
 *   - the filename convention `*.db.test.ts`, or
 *   - the `*_test`-database guard every truncating suite carries:
 *     `/_test(\b|$|\?)/` / `/_test(\b|$)/` (`isTestDb`), the same check the
 *     suites use to refuse to run against a real database.
 *
 * Of those, DB-REQUIRED files abort at module scope when DATABASE_URL isn't a
 * `*_test` database — either via their own `if (!/_test…` throw or the shared
 * `assertTestDatabase()` helper — so they can only run under a DB project. The rest wrap every DB case in `skipIf(!isTestDb)` and are safe
 * everywhere: they run their non-DB cases under `unit` and light up fully
 * wherever a *_test DATABASE_URL is present.
 *
 * A new DB suite needs no registration: carry the standard guard (or the
 * .db.test.ts name) and both lanes pick it up automatically. If a DB suite
 * forgets the guard entirely it lands in `unit` and fails loudly there —
 * fail-loud, never silently skipped. The dedicated full authorization project
 * below is the explicit fresh-install exception to shared database execution.
 */
const DB_COUPLING = /\/_test\(|\bisTestDb\b|\bassertTestDatabase\b/;
const SELF_SKIPS = /\.skipIf\(!isTestDb\)/;

const allTests = collectTestFiles(join(ROOT, 'src'));
const dbGated = allTests.filter(
  (file) => file.endsWith('.db.test.ts') || DB_COUPLING.test(readFileSync(join(ROOT, file), 'utf8')),
);
const dbRequired = dbGated.filter((file) => !SELF_SKIPS.test(readFileSync(join(ROOT, file), 'utf8')));

// Bootstrap owns a fresh installation in one process, isolated from shared DB suite state.
// Explicit project remains included by test:all & is required separately in public engine CI.
const authorizationQualified = 'src/sdk/authorization-matrix.qualified.db.test.ts';
// The enrolled-only B2.8 regression suite (343 contracts) needs a fresh database of its own: its fixtures insert the
// installation administrator (admin_user_installation_admin_unique), so it can follow neither the qualified bootstrap
// nor the shared db lane, and its contract test exceeded 300 s on the CI runner (2026-10-20). Separate project, separate
// database, generous budget (CI: "Enrolled-only authorization regressions").
const authorizationEnrolled = 'src/sdk/authorization-matrix.db.test.ts';
if (!dbRequired.includes(authorizationQualified)) throw new Error('required full authorization matrix suite is missing');

export default defineConfig({
  test: {
    // RLS tests share one database and mutate it — never run files in parallel.
    fileParallelism: false,
    // A real Postgres connection per test; give it room.
    testTimeout: 20000,
    hookTimeout: 20000,
    projects: [
      {
        // `pnpm test` — everything that runs without a database.
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: dbRequired,
        },
      },
      {
        // Shared DB suites; fresh-install bootstrap has its own required project.
        extends: true,
        test: {
          name: 'db',
          include: dbGated.filter(file => file !== authorizationQualified && file !== authorizationEnrolled),
        },
      },
      {
        // Root provisions a fresh dedicated *_test database; this lane never resets it.
        extends: true,
        test: {
          name: 'authorization-matrix',
          include: [authorizationQualified],
        },
      },
      {
        // Root provisions a second fresh *_test database for this lane; never shared with the qualified bootstrap.
        extends: true,
        test: {
          name: 'authorization-enrolled',
          include: [authorizationEnrolled],
        },
      },
    ],
  },
});
