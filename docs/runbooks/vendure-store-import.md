# Vendure store import runbook

`packages/api/src/import/` reads a source Vendure store's database (read-only,
`REPEATABLE READ READ ONLY`) and writes it into a fresh SellRight tenant in
one target transaction. `assert-no-vendure.sh` explicitly allowlists this
directory — it's the one place in `packages/api/src` allowed to talk about
Vendure at all, because reading a Vendure source is its entire job.

This page covers the asset-file side of that import: `stageVendureAssets`
(`packages/api/src/import/artifacts.ts`), which copies the actual image files
an imported `asset` row points at — not just the DB row.

## Two roots, one relative path

The migration config (`migrationConfig` in `run.ts`) requires two directories:

```json
{
  "sourceAssetRoot": "/path/to/the/source/instance/assets",
  "targetAssetRoot": "/path/to/this/deployment/ASSET_DIR"
}
```

- `sourceAssetRoot` is the source instance's assets directory (its
  `source`/`preview`/`cache` subtrees).
- `targetAssetRoot` is **this deployment's `ASSET_DIR`** — the directory your
  web server serves at the public assets path. The API never serves asset
  bytes itself; the file has to land inside `ASSET_DIR` for the storefront to
  actually render it.

Every `asset.source` / `asset.preview` value read from the source DB is a
path relative to `sourceAssetRoot` (e.g. `preview/83/img_3697__preview.png`).
`catalog.ts` writes the target `asset.path` DB column as:

```
<storeId>/<ASSET_KEY_SEGMENT>/<that same relative path>
```

`ASSET_KEY_SEGMENT` (`artifacts.ts`) is the fixed literal `'media'` — a
neutral segment name, never the source platform's name (a dedicated test
enforces the target path never matches `/vendure/i`). `stageVendureAssets`
copies each file to that identical relative path under `targetAssetRoot`, so
the DB row and the file on disk always agree:

```
<ASSET_DIR>/<storeId>/media/<relative path>
```

A store migrated before `ASSET_KEY_SEGMENT` was renamed to `media` may have
legacy rows using an older segment name on disk — that's historical data, not
something new imports produce; new imports are always `media`.

## Running it

```bash
SOURCE_DATABASE_URL=... DATABASE_URL=... \
  pnpm --filter @sellright/api import:vendure -- \
  --config /private/path/to/config.json \
  --manifest /private/path/to/manifest.json \
  [--source-assets /path/to/source/assets] \
  [--target-assets /path/to/ASSET_DIR] \
  [--apply --expected-digest <digest from the dry run>]
```

- No `--apply`: dry run. Reads everything, including asset files (to compute
  their hashes for the manifest digest), writes nothing, `ROLLBACK`s the
  target transaction. `--source-assets`/`--target-assets` are read-only in
  this mode — nothing is written or created, not even directories.
- `--apply --expected-digest <digest>`: re-runs the exact same read against
  the exact same source and target roots, checks it reproduces
  `<digest>` (the dry run's `sourceDigest`), and only then commits — DB rows
  and asset files together.
- `--source-assets` / `--target-assets` override the config file's
  `sourceAssetRoot` / `targetAssetRoot` for this invocation only, without
  editing the (mode-0600) config file — handy for pointing a rehearsal run at
  a scratch asset tree. They still pass through the same `z.string().min(1)`
  validation as the config fields; there is no bypass.

The CLI's own JSON result line reports `assetCounts: { copied, skipped,
missing }` alongside the row counts per table.

## Idempotency

Re-running the same config (dry run or apply, against the same source and
target roots) is safe:

- A target file that doesn't exist yet is copied (`counts.copied`).
- A target file that already exists with the **same** sha256 is left alone
  (`counts.skipped`) — no rewrite, no truncate-then-rewrite race.
- A target file that already exists with a **different** sha256 throws
  `Existing asset differs` and aborts the run. That's a real conflict (two
  different imports, or a hand-edited file, claiming the same path) that
  needs a human to look at — it is never silently overwritten.

Dry-run mode reports the same copied/skipped/missing breakdown as apply mode
without writing anything: it stats the would-be target file (or, if the
target tree doesn't exist yet at all — e.g. the very first run for a new
store — treats that identically to "not there yet") and classifies it, but
only actually opens the source file for hashing and never opens the target
for write.

## Missing files are a warning, not a crash

If neither `asset.source` nor its sibling `asset.preview` (when it has one)
can be read from `sourceAssetRoot` (`ENOENT` on both), that one file is
recorded in `missing: [{ path, targetPath }]` and the loop continues — it
does **not** abort the rest of the asset copy or the migration. `run.ts`
turns every entry into a reviewed `asset-missing` manifest exclusion naming
the path, the would-be target path, and the DB `asset.id`(s) that reference
it, so an operator sees exactly which products will show a broken image
before deciding whether to go live. (Any other read failure — corrupt file,
over the size limit, a rejected symlink — still throws; only a genuine
"file's not there" is downgraded to a warning.)

This is the same review-not-silent-drop pattern the migration already uses
for `asset-source-fallback` (a source file missing but its preview present —
the preview's bytes are used and the substitution is reported) and for every
other `ManifestExclusion` type (`unmapped-source-field`,
`unmappable-source-row`, etc.).

## Path safety

`stageVendureAssets` never writes outside `targetAssetRoot` and never reads
outside `sourceAssetRoot`:

- Every relative path is rejected if it's absolute, contains `\` or a NUL
  byte, or has any `.`/`..`/empty segment (`withinRoot` in `artifacts.ts`).
- Every directory and file is opened with `O_NOFOLLOW` through a pinned
  parent directory file descriptor (`/proc/self/fd/<fd>/<part>`), so a
  symlink swapped in after the traversal check — in either the source or the
  destination tree — is rejected at open time (`ELOOP`/`EPERM`), not followed.
  This applies in dry-run mode too, not only `--apply`.
- The store id is validated as a UUID before it's used as a path segment.

`artifacts.test.ts` exercises all of this against real temp directories:
traversal strings, a symlinked source file, a symlinked destination
directory, and a symlinked destination file swapped in for an existing
target — the last two assert the symlink's actual target file is never
touched.
