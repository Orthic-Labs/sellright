# Staged build and swap tools

Generic tools for building a composed storefront tree in a stage next to the live tree, swapping it in after an origin smoke, and
rolling back. They carry no brand name, path or URL: every such value comes from a JSON config file (`--config`, shape documented
above `loadConfig` in `lib.mjs`). Plan A §4.2, §4.5, §4.6a; findings C1 to C11 of the cutover review.

| File | Role |
|---|---|
| `entry.mjs` | `build`, `activate`, `purge`, `deploy`, `restore-previous`, `recover`. The only writer of `.deploy-state/storefront.json`. |
| `rollback.mjs` | `previous`, `composed [<history-id>]`, `legacy --legacy-tag <tag>`. Drives the entry's steps. |
| `stage.mjs` | seed, artifact check, server carry-over, swap, restore, undo of a half-done swap. |
| `build-guard.mjs` | The inner build script calls it first; exit 6 unless the deploy entry started the build. |
| `preflight-env.mjs` | Exit 4 when a build selector (`SELLRIGHT_BUILD_SUFFIX`, `VITE_*`, ...) is set. |
| `smoke-supervisor.mjs` | Runs the candidate/rehearsal server for the origin smoke as a detached process group that exits with its parent; its pid and start time are journaled in `.deploy-state/smoke-child.json` and `recover` stops it. |
| `origin-smoke.mjs` | Plain HTTP GETs against an origin with a chosen `Host`. |
| `lib.mjs` | Exit codes, config, state file, lock (kernel-backed, `../compose/lib/os-lock.mjs`, Linux), log, command runner, root rule. |

A rollback records its kind, target and direction in `.deploy-state/rollback-op.json` before it acts and removes the record only after its purge; every retry of that kind (after a failed restart, smoke or purge, or a kill) resumes the recorded operation instead of selecting a target, rebuilding or swapping again.

One lock per brand repo: the deployment lock (`.deploy-state/lock`) is also taken by every standalone compose mode, `stage.mjs seed|carry-server` and the drift writers; a compose started by an operation that holds it runs inside it (verified descriptor 3). The artifact check requires what the SSR build produces (`server/entry.express.js`, `dist/q-manifest.json`, non-empty `dist/build/`); there is no `dist/index.html` because nothing is prerendered.

Run from `packages/storefront`: `pnpm test:tools` (every test file of the tools).

Nothing here touches stock: no cache, debounce or TTL of any kind.
