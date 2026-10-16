#!/usr/bin/env bash
# Scratch layouts for the isolated harness (plan A5b). EVERYTHING lives under /home/vendure/sites/.work/harness/<run>/;
# nothing is written into a repo or into a read-only release checkout. No node -e. Not run when it was written.
#
#   scratch-layout.sh new <pin>                  create <run>, record STAMP, extract the pin, install, build the client
#   scratch-layout.sh base <run>                 base scratch: the extracted storefront + e2e + the Stripe seam fixture route
#   scratch-layout.sh rotten <run>               Rotten legacy scratch (copy of rotten/store) linked to the built pinned client
#   scratch-layout.sh containment <run>          fail if anything outside <run> (in the guarded trees) changed since STAMP
#
# <pin> is a FULL 40-character SHA that exists in $SR_REPO (default /home/vendure/sites/sellright).
# The API checkout (E2E_API_DIR) comes from ops/sellright-release.sh <pin>, exactly as plan A5 item 4 says; this script
# only prints the path it expects.
set -euo pipefail

SR_REPO="${SR_REPO:-/home/vendure/sites/sellright}"
HARNESS_ROOT="${HARNESS_ROOT:-/home/vendure/sites/.work/harness}"
RH_STORE="${RH_STORE:-/home/vendure/sites/rotten/store}"
RH_SCRIPTS="${RH_SCRIPTS:-/home/vendure/sites/rotten/scripts}"
HERE="$(cd "$(dirname "$0")" && pwd)"
FIXTURE="$HERE/../scratch/stripe-seam-fixture.tsx"

die() { echo "scratch-layout: $*" >&2; exit 1; }
need_run() { [ -d "${1:-}" ] || die "run directory '${1:-}' does not exist"; case "$1" in "$HARNESS_ROOT"/*) ;; *) die "run directory must be under $HARNESS_ROOT";; esac; }

cmd="${1:-}"; shift || true
case "$cmd" in
  new)
    pin="${1:-}"
    [[ "$pin" =~ ^[0-9a-f]{40}$ ]] || die "pin must be a full 40-character SHA"
    git -C "$SR_REPO" cat-file -e "$pin^{commit}" 2>/dev/null || die "$pin is not a commit in $SR_REPO"
    mkdir -p "$HARNESS_ROOT"
    run="$(mktemp -d "$HARNESS_ROOT/run.XXXXXX")"
    stamp="$run/.stamp"; : > "$stamp"          # containment reference time: taken BEFORE anything is extracted
    echo "$pin" > "$run/pin"
    mkdir -p "$run/sr" "$run/run" "$run/catalog"
    # Step 1: partial extract (plan: UNVERIFIED that it installs frozen) ...
    git -C "$SR_REPO" archive "$pin" packages/storefront packages/storefront-client tsconfig.base.json \
        package.json pnpm-workspace.yaml pnpm-lock.yaml | tar -x -C "$run/sr"
    if ! (cd "$run/sr" && pnpm install --frozen-lockfile); then
      # ... fallback written in the plan: a full archive of the pin.
      echo "scratch-layout: partial extract did not install frozen; falling back to a full archive of $pin" >&2
      rm -rf "$run/sr" && mkdir -p "$run/sr"
      git -C "$SR_REPO" archive "$pin" | tar -x -C "$run/sr"
      (cd "$run/sr" && pnpm install --frozen-lockfile)
      echo "full-archive" > "$run/sr-mode"
    else
      echo "partial" > "$run/sr-mode"
    fi
    pnpm --dir "$run/sr/packages/storefront-client" run build
    test -f "$run/sr/packages/storefront-client/dist/index.js" || die "client build produced no dist/index.js"
    echo "run=$run"
    echo "API checkout (plan A5 item 4): bash /home/vendure/sites/ops/sellright-release.sh $pin   ->   E2E_API_DIR=/home/vendure/releases/sellright/$pin/packages/api"
    ;;

  base)
    run="${1:-}"; need_run "$run"
    sf="$run/sr/packages/storefront"
    [ -d "$sf/e2e" ] || die "$sf/e2e missing: run 'new' first"
    # The Stripe seam fixture route exists only in the scratch (A6 item 5).
    mkdir -p "$sf/src/routes/__stripe-seam-fixture"
    cp "$FIXTURE" "$sf/src/routes/__stripe-seam-fixture/index.tsx"
    (cd "$sf" && VITE_SELLRIGHT_STORE_SLUG=e2e pnpm run e2e:build)
    echo "base scratch ready: $sf"
    echo "env: E2E_RUN_DIR=$run/run E2E_CATALOG_DIR=$run/catalog E2E_SUPPORT_DIR=$sf/e2e/support E2E_API_DIR=<release checkout>/packages/api E2E_STRIPE=1 E2E_STRIPE_SEAM=1"
    ;;

  rotten)
    run="${1:-}"; need_run "$run"
    [ -d "$RH_STORE" ] || die "$RH_STORE not found"
    dest="$run/rotten"
    mkdir -p "$dest" "$run/scripts"
    # Dirty files are copied exactly as they are on disk; the list goes into the run notes.
    (cd "$RH_STORE" && tar --exclude=./node_modules --exclude=./dist --exclude=./server --exclude='./.env*' --exclude=./tmp -cf - .) | tar -x -C "$dest"
    git -C "$(dirname "$RH_STORE")" status --short -- store > "$run/rotten-dirty-files.txt" || true
    # D2's declared external: ../scripts/node-heap-options.mjs relative to the build dir.
    cp "$RH_SCRIPTS/node-heap-options.mjs" "$run/scripts/node-heap-options.mjs"
    # Scratch-only package.json edit: link the BUILT pinned client; add @playwright/test at the pin's version.
    pw="$(grep -m1 '"@playwright/test"' "$run/sr/packages/storefront/package.json" | sed -E 's/.*: *"([^"]+)".*/\1/')"
    [ -n "$pw" ] || die "could not read the @playwright/test version from the pin"
    node "$HERE/scratch-edit-package.mjs" "$dest/package.json" \
      "dep:@sellright/storefront-client=link:$run/sr/packages/storefront-client" "dep:@playwright/test=$pw"
    # The scratch edit changes the manifest, so no frozen lock: recorded in the run notes.
    echo "pnpm install without --frozen-lockfile (scratch package.json edited)" >> "$run/notes.txt"
    (cd "$dest" && pnpm install --no-frozen-lockfile)
    mkdir -p "$dest/src/routes/__stripe-seam-fixture"
    cp "$FIXTURE" "$dest/src/routes/__stripe-seam-fixture/index.tsx"
    echo "rotten scratch ready: $dest (dirty files: $run/rotten-dirty-files.txt)"
    echo "A7 still has to add SELLRIGHT_DISABLE_SSG/SELLRIGHT_BUILD_SUFFIX to the scratch's two vite configs before the e2e build (plan A7 item 1)."
    ;;

  containment)
    run="${1:-}"; need_run "$run"
    stamp="$run/.stamp"; [ -f "$stamp" ] || die "no $stamp"
    bad=0
    for tree in /home/vendure/sites/sellright /home/vendure/sites/rotten /home/vendure/releases /home/vendure/sites/sellright-data; do
      [ -d "$tree" ] || continue
      hits="$(find "$tree" \( -name node_modules -o -name .git \) -prune -o -type f -newer "$stamp" -print 2>/dev/null | head -50 || true)"
      if [ -n "$hits" ]; then echo "containment: files changed since the stamp under $tree:"; echo "$hits"; bad=1; fi
    done
    for tree in /home/vendure/sites/damned*; do
      [ -d "$tree" ] || continue
      hits="$(find "$tree" \( -name node_modules -o -name .git \) -prune -o -type f -newer "$stamp" -print 2>/dev/null | head -50 || true)"
      if [ -n "$hits" ]; then echo "containment: files changed since the stamp under $tree:"; echo "$hits"; bad=1; fi
    done
    [ "$bad" -eq 0 ] && echo "containment: clean" || { echo "containment: FAILED — read the list (concurrent edits by other sessions show up here by design)" >&2; exit 1; }
    ;;

  *) die "usage: scratch-layout.sh new <pin> | base <run> | rotten <run> | containment <run>" ;;
esac
